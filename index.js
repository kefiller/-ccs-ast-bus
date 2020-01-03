#!/usr/bin/env docker-node

const os = require('os');
const { isNil, some, get, map, flow, concat } = require('lodash');
const AmiClient = require('asterisk-ami-client');
const amqp = require('amqplib');
const uuidv1 = require('uuid/v1');

const hostname = os.hostname();

function bail(msg) {
    console.log('Fatal - ' + msg);
    process.exit(1);
}

process.on('SIGINT', () => {
    console.log('Received SIGINT, exit');
    amiClient.disconnect();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, exit');
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
    console.log('Some of required AMI_* env variables not set');
    process.exit(1);
}

amiClient
    .on('connect', () => console.log(`connected to ${ami_host} successfully`))
    .on('response', response => console.log('response', response))
    .on('disconnect', () => console.log(`disconnected from ${ami_host}`))
    .on('reconnection', () => console.log(`reconnection to ${ami_host}`))
    .on('internalError', error => bail('internalError:' + error));

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

const amiOriginateAction = (amiClient, fn = null) => {
    const toArr = (obj) => {
        return map(obj, (val, key) =>{
            return `${key}: ${val}`;
        });
    }

    const addVars = (obj) => (cmdArr) => {
        const varsArr =  map(obj, (val, key) =>{
            return `Variable: ${key}=${val}`;
        });
        return concat(cmdArr, varsArr);
    }

    const join = (str) => (arr) => {
        return arr.join(str);
    }
    
    const uuid = uuidv1();
    const action = {
        Action: 'Originate',
        channel: 'SIP/atk-lv/89201911686^79190690417^12414',
        callerid: '79190690417',
        timeout: '40000',
        context: 'api-originate',
        exten: '9998',
        priority: '1',
        async: 'true'
    };

    const origVars = {
        'BRIDGE-TARGET' : 'dialplan',
        'BRT-CTX' : 'internal',
        'BRT-EXTEN' : '9998',
        'API-CALL-ID' : `${uuid}`,
    };

    const f = flow([
        withActionId(uuid),
        toArr,
        addVars(origVars),
        join("\r\n")
    ]);

    console.log(f(action));
    
    if(fn) {
        withStdReponse(amiClient, uuid, fn);
    }

    amiClient.connection.write(f(action));
};

const amiOriginateResponse = (response) => {
    console.log('amiOriginateResponse', response);
};

const amiPauseAction = () => {
    return {
        Action: 'Pause',
    }
}

const amiPingAction = (amiClient, fn = null) => {
    const uuid = uuidv1();
    const action = {
        Action: 'Ping',
    };
    
    if(fn) {
        withStdReponse(amiClient, uuid, fn);
    }

    amiClient.action(withActionId(uuid)(action));
}

const amiPingResponse = (response) => {
    console.log('amiPingResponse', response);
}

(async () => {
    try {
        process.stdout.write(`Connecting to rabbitmq server ${rabbit_srv}...`);
        const conn = await amqp.connect(`amqp://${rabbit_srv}`);
        console.log('Success');

        process.stdout.write(`Creating rabbitmq communication channel...`);
        const channel = await conn.createChannel();
        console.log('Success');

        // Create exchanges if not exists
        console.log(`Making sure exchange ${pbx_events_exchange} exists`);
        channel.assertExchange(pbx_events_exchange, 'topic', {
            durable: false
        });

        console.log(`Making sure exchange ${pbx_cmd_exchange} exists`);
        channel.assertExchange(pbx_cmd_exchange, 'topic', {
            durable: false
        });

        // Emit asterisk events to message bus callback (bind before any events arrived)
        amiClient.on('event', event => {
            console.log(event);
            event['pbx.server'] = hostname;
            channel.publish(pbx_events_exchange, exchange_key, Buffer.from(JSON.stringify(event)));
        });

        console.log(`Connecting to AMI server ${ami_host}...`);
        await amiClient.connect(ami_user, ami_password, { host: ami_host, port: 5038 });

        // amiPingAction(amiClient, amiPingResponse);
        amiOriginateAction(amiClient, amiPingResponse);

        // Listen for commands

        // generate name for temp queue
        const { queue } = await channel.assertQueue('', {
            exclusive: true
        });
        // connect queue to cmd exchange. Receive commands only for current hostname
        console.log(`Binding temporary queue ${queue} to command exchange ${pbx_cmd_exchange} with routing key ${pbx_cmd_routing_key}`);
        channel.bindQueue(queue, pbx_cmd_exchange, pbx_cmd_routing_key);
        channel.consume(queue, ({ fields: { routingKey }, content = null }) => {
            if (!content) return;
            console.log(" [x] Received %s: '%s'", routingKey, content.toString());
        }, {
            noAck: true
        });

    } catch (error) {
        bail(error.message);
    }
})();

