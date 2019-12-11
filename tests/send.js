#!/usr/bin/env node

let amqp = require('amqplib');

const srv = 'dclvccsast.guo.local';
const exchange = 'ccs_events';
const key = 'ccs.ast.evt.test';

(async () => {
    try {
        const conn = await amqp.connect(`amqp://${srv}`);
        const channel = await conn.createChannel();

        setTimeout(() => {
            console.log('disconnecting');
            conn.close();
            process.exit(0);
        }, 5000);

        channel.assertExchange(exchange, 'topic', {
            durable: false
        });

        const msg = 'Hello World!';
        channel.publish(exchange, key, Buffer.from(msg));

        console.log(" [x] Sent %s:'%s'", key, msg);
    } catch (error) {
        console.log(error);
    }
})();
