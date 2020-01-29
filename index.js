#!/usr/bin/env docker-node

const os = require('os');
const { isNil, some, get, map, flow, concat, noop } = require('lodash');
const AmiClient = require('asterisk-ami-client');
const amqp = require('amqplib');
const uuidv1 = require('uuid/v1');
const log = require('loglevel');

const hostname = os.hostname();

function bail(msg) {
    log.error('Fatal - ' + msg);
    process.exit(1);
}

process.on('SIGINT', () => {
    log.info('Received SIGINT, exit');
    amiClient.disconnect();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log.info('Received SIGTERM, exit');
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
const pbx_name = get(process.env, 'PBX_NAME', hostname);
log.setLevel(get(process.env, 'LOG_LEVEL', 'info'));

// PBX events topic name
const pbx_events_exchange = get(process.env, 'PBX_EVENTS_EXCHANGE', 'ccs_pbx_events');
const pbx_events_key_prefix = get(process.env, 'PBX_EVENTS_KEY_PREFIX', 'ccs.pbx.evt');

// PBX events exchange key
const exchange_key = `${pbx_events_key_prefix}.${hostname}`;

// PBX commands topic name
const pbx_cmd_exchange = get(process.env, 'PBX_CMD_EXCHANGE', 'ccs_pbx_cmd');
const pbx_cmd_routing_key_prefix = get(process.env, 'PBX_CMD_ROUTING_KEY_PREFIX', 'ccs.pbx.cmd');
// const pbx_cmd_routing_key = `${pbx_cmd_routing_key_prefix}.${hostname}`;
const pbx_cmd_routing_key = `${pbx_cmd_routing_key_prefix}.#`;

if (some([ami_host, ami_user, ami_password], isNil)) {
    log.info('Some of required AMI_* env variables not set');
    process.exit(1);
}

amiClient
    .on('connect', () => log.info(`connected to ${ami_host} successfully`))
    .on('disconnect', () => log.info(`disconnected from ${ami_host}`))
    .on('reconnection', () => log.info(`reconnection to ${ami_host}`))
    .on('internalError', error => bail('internalError:' + error));

// .on('response', response => log.info('response', response))

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

    // const uuid = uuidv1();
    // origVars['API-CALL-ID'] = uuid;

    const uuid = action.actionid;

    const f = flow([
        // withActionId(uuid),
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
            amiAction(amiClient, action, resp => log.debug('ping response', resp) /*, eventFn = evt => log.info('Evt', evt) */);
        } break;
        case 'pause_queue_member': {
            const member = cmd.member;
            const action = {
                Action: 'QueuePause',
                Interface: `sip/${member}`,
                Paused: 'true'
            }
            amiAction(amiClient, action, resp => log.debug('pause_queue_member response', resp) /*, eventFn = evt => log.info('Evt', evt) */);
        } break;
        case 'unpause_queue_member': {
            const member = cmd.member;
            const action = {
                Action: 'QueuePause',
                Interface: `sip/${member}`,
                Paused: 'false'
            }
            amiAction(amiClient, action, resp => log.debug('unpause_queue_member response', resp));
        } break;
        case 'originate': {
            log.debug('originate', cmd);
            const action = cmd.keys;
            const origVars = cmd.vars;
            amiOriginateAction(
                amiClient, action, origVars, /*amiOriginateResponse, amiOriginateEventListener*/
            );
        } break;

        default:
            log.info(`unknown action_type='${action_type}'`);
            break;
    }
}

(async () => {
    try {
        log.info(`Connecting to rabbitmq server ${rabbit_srv}...`);
        const conn = await amqp.connect(`amqp://${rabbit_srv}`);
        log.info(`Connected to rabbitmq server ${rabbit_srv} successfully`);

        log.info(`Creating rabbitmq communication channel...`);
        const channel = await conn.createChannel();
        log.info('Created rabbitmq communication channel successfully`');

        // Create exchanges if not exists
        log.info(`Making sure exchange ${pbx_events_exchange} exists`);
        channel.assertExchange(pbx_events_exchange, 'topic', {
            durable: false
        });

        log.info(`Making sure exchange ${pbx_cmd_exchange} exists`);
        channel.assertExchange(pbx_cmd_exchange, 'topic', {
            durable: false
        });

        // Emit asterisk events to message bus callback (bind before any events arrived)
        amiClient.on('event', event => {
            event['srv'] = pbx_name;
            log.debug(" [x] Received event to publish:", event.Event || 'empty');
            channel.publish(pbx_events_exchange, exchange_key, Buffer.from(JSON.stringify(event)));
        });

        log.info(`Connecting to AMI server ${ami_host}...`);
        await amiClient.connect(ami_user, ami_password, { host: ami_host, port: 5038 });

        // Listen for commands

        // generate name for temp queue
        const { queue } = await channel.assertQueue('', {
            exclusive: true
        });
        // connect queue to cmd exchange. Receive commands only for current hostname
        log.info(`Binding temporary queue ${queue} to command exchange ${pbx_cmd_exchange} with routing key ${pbx_cmd_routing_key}`);
        channel.bindQueue(queue, pbx_cmd_exchange, pbx_cmd_routing_key);
        channel.consume(queue, ({ fields: { routingKey }, content = null }) => {
            if (!content) {
                log.warn("Received empty packet. RoutingKey:'%s'", routingKey);
                return;
            }
            let payload = null;
            try {
                payload = JSON.parse(content.toString());
            } catch (error) {
                return log.warn("Received unparseable packet. RoutingKey:'%s', packet:'%s'", routingKey, content.toString());
            }

            log.debug(" [x] Received good packet. RoutingKey:'%s'", routingKey);
            // Handle if our packet. Our if:
            // 1) is broadcast, and routingKey === pbx_cmd_routing_key_prefix (no tail)
            // 2) tail is ours pbx_name
            if(routingKey === pbx_cmd_routing_key_prefix || routingKey.replace(`${pbx_cmd_routing_key_prefix}.`, '') === pbx_name) {
                log.debug('Handle ours packet:', payload);
                dispatchCommand(amiClient, payload);
            }
        }, {
            noAck: true
        });

    } catch (error) {
        bail(error.message);
    }
})();

