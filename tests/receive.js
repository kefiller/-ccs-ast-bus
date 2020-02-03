#!/usr/bin/env node

const amqp = require('amqplib');

const srv = 'dclvccsast.guo.local';
const exchange = 'ccs_events';

(async () => {
    try {
        const conn = await amqp.connect(`amqp://${srv}`);

        const channel = await conn.createChannel();

        channel.assertExchange(exchange, 'topic', {
            durable: false
        });

        const { queue } = await channel.assertQueue('', {
            exclusive: true
        });

        channel.bindQueue(queue, exchange, "ccs.ast.evt.*");

        console.log(" [*] Waiting for messages in %s. To exit press CTRL+C", queue);
        channel.consume(queue, ({ fields : {routingKey}, content = null }) => {
            if (!content) return;
            console.log(" [x] Received %s: '%s'", routingKey, content.toString());
        }, {
            noAck: true
        });

    } catch (error) {
        console.log(error);
    }
})();
