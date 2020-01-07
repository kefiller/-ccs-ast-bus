#!/usr/bin/env docker-node

const os = require('os');
const { isNil, some, get, map, flow, concat, noop } = require('lodash');
const AmiClient = require('asterisk-ami-client');
const amqp = require('amqplib');
const uuidv1 = require('uuid/v1');

const log = (...args) => console.log(...args);
const trace = log;

const hostname = os.hostname();

function bail(msg) {
    log('Fatal - ' + msg);
    process.exit(1);
}

process.on('SIGINT', () => {
    log('Received SIGINT, exit');
    amiClient.disconnect();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('Received SIGTERM, exit');
    amiClient.disconnect();
    process.exit(0);
});

const amiClient = new AmiClient({
    reconnect: true,
    keepAlive: true,
    maxAttemptsCount: 99,
    attemptsDelay: 10000,
    keepAlive: true,
    keepAliveDelay: 10000,
});

const ami_host = process.env.AMI_HOST;
const ami_user = process.env.AMI_USER;
const ami_password = process.env.AMI_PASSWORD;

const rabbit_srv = get(process.env, 'RABBIT_SRV', '127.0.0.1');

// PBX events topic name
const pbx_events_exchange = get(process.env, 'PBX_EVENTS_EXCHANGE', 'ccs_pbx_events');
const pbx_events_key_prefix = get(process.env, 'PBX_EVENTS_KEY_PREFIX', 'ccs.pbx.evt');

// PBX events exchange key
const exchange_key = `${pbx_events_key_prefix}.${hostname}`;

// PBX commands topic name
const pbx_cmd_exchange = get(process.env, 'PBX_CMD_EXCHANGE', 'ccs_pbx_cmd');
const pbx_cmd_routing_key_prefix = get(process.env, 'PBX_CMD_ROUTING_KEY_PREFIX', 'ccs.pbx.cmd');
const pbx_cmd_routing_key = `${pbx_cmd_routing_key_prefix}.${hostname}`;

if (some([ami_host, ami_user, ami_password], isNil)) {
    log('Some of required AMI_* env variables not set');
    process.exit(1);
}

amiClient
    .on('connect', () => log(`connected to ${ami_host} successfully`))
    .on('disconnect', () => log(`disconnected from ${ami_host}`))
    .on('reconnection', () => log(`reconnection to ${ami_host}`))
    .on('internalError', error => bail('internalError:' + error));

// .on('response', response => log('response', response))

const withActionId = (ActionID) => (action) => {
    return {
        ...action,
        ActionID
    }
}

const withStdReponse = (amiClient, ActionID, fn) => {
    amiClient.on(`resp_${ActionID}`, response => {
        fn(response);
        amiClient.removeAllListeners(`resp_${ActionID}`);
    });
};

const amiOriginateAction = (amiClient, action, origVars, responseFn = null, eventFn = null) => {
    const toArr = (obj) => {
        return map(obj, (val, key) => {
            return `${key}: ${val}`;
        });
    }

    const addVars = (obj) => (cmdArr) => {
        const varsArr = map(obj, (val, key) => {
            return `Variable: ${key}=${val}`;
        });
        return concat(cmdArr, varsArr);
    }

    const join = (str) => (arr) => {
        return arr.join(str);
    }

    const uuid = uuidv1();

    origVars['API-CALL-ID'] = uuid;

    const f = flow([
        withActionId(uuid),
        toArr,
        addVars(origVars),
        join("\r\n")
    ]);

    if (responseFn) {
        withStdReponse(amiClient, uuid, responseFn);
    }

    if (eventFn) {
        const evtListener = evt => {
            if (evt.ActionID === uuid) {
                eventFn(evt);
                amiClient.removeListener('event', evtListener);
            }
        }
        amiClient.on('event', evtListener);
    }

    amiClient.connection.write(f(action));
};

const amiAction = (amiClient, action, responseFn = null, eventFn = null) => {
    const uuid = uuidv1();
    if (responseFn) {
        withStdReponse(amiClient, uuid, responseFn);
    }
    if (eventFn) {
        const evtListener = evt => {
            if (evt.ActionID === uuid) {
                eventFn(evt);
                amiClient.removeListener('event', evtListener);
            }
        }
        amiClient.on('event', evtListener);
    }

    amiClient.action(withActionId(uuid)(action));
}

const dispatchCommand = (amiClient, cmd = {}) => {
    const action_type = cmd.action_type || '';

    switch (action_type) {
        case 'ping': {
            const action = {
                Action: 'Ping',
            };
            amiAction(amiClient, action, resp => trace('ping response', resp) /*, eventFn = evt => log('Evt', evt) */);
        } break;
        case 'pause_queue_member': {
            const member = cmd.member;
            const action = {
                Action: 'QueuePause',
                Interface: `sip/${member}`,
                Paused: 'true'
            }
            amiAction(amiClient, action, resp => trace('pause_queue_member response', resp) /*, eventFn = evt => log('Evt', evt) */);
        } break;
        case 'unpause_queue_member': {
            const member = cmd.member;
            const action = {
                Action: 'QueuePause',
                Interface: `sip/${member}`,
                Paused: 'false'
            }
            amiAction(amiClient, action, resp => trace('unpause_queue_member response', resp));
        } break;
        case 'originate': {
            // const action = {
            //     Action: 'Originate',
            //     channel: 'SIP/atk-lv/89201911686^79190690417^12414',
            //     callerid: '79190690417',
            //     timeout: '40000',
            //     context: 'api-originate',
            //     exten: '9998',
            //     priority: '1',
            //     async: 'true'
            // };

            // const origVars = {
            //     'BRIDGE-TARGET' : 'dialplan',
            //     'BRT-CTX' : 'internal',
            //     'BRT-EXTEN' : '9998',
            // };
            // amiOriginateAction(amiClient, action, origVars, amiOriginateResponse, amiOriginateEventListener);

        } break;

        default:
            log(`unknown action_type='${action_type}'`);
            break;
    }
}

(async () => {
    try {
        process.stdout.write(`Connecting to rabbitmq server ${rabbit_srv}...`);
        const conn = await amqp.connect(`amqp://${rabbit_srv}`);
        log('Success');

        process.stdout.write(`Creating rabbitmq communication channel...`);
        const channel = await conn.createChannel();
        log('Success');

        // Create exchanges if not exists
        log(`Making sure exchange ${pbx_events_exchange} exists`);
        channel.assertExchange(pbx_events_exchange, 'topic', {
            durable: false
        });

        log(`Making sure exchange ${pbx_cmd_exchange} exists`);
        channel.assertExchange(pbx_cmd_exchange, 'topic', {
            durable: false
        });

        // Emit asterisk events to message bus callback (bind before any events arrived)
        amiClient.on('event', event => {
            // log(event);
            event['pbx.server'] = hostname;
            channel.publish(pbx_events_exchange, exchange_key, Buffer.from(JSON.stringify(event)));
        });

        log(`Connecting to AMI server ${ami_host}...`);
        await amiClient.connect(ami_user, ami_password, { host: ami_host, port: 5038 });

        // Listen for commands

        // generate name for temp queue
        const { queue } = await channel.assertQueue('', {
            exclusive: true
        });
        // connect queue to cmd exchange. Receive commands only for current hostname
        log(`Binding temporary queue ${queue} to command exchange ${pbx_cmd_exchange} with routing key ${pbx_cmd_routing_key}`);
        channel.bindQueue(queue, pbx_cmd_exchange, pbx_cmd_routing_key);
        channel.consume(queue, ({ fields: { routingKey }, content = null }) => {
            if (!content) {
                log("Received empty packet. RoutingKey:'%s'", routingKey);
                return;
            }
            let payload = null;
            try {
                payload = JSON.parse(content.toString());
            } catch (error) {
                return log("Received unparseable packet. RoutingKey:'%s', packet:'%s'", routingKey, content.toString());
            }

            trace(" [x] Received good packet. RoutingKey:'%s'", routingKey, payload);
            dispatchCommand(amiClient, payload);
        }, {
            noAck: true
        });

    } catch (error) {
        bail(error.message);
    }
})();

