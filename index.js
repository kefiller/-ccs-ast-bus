#!/usr/bin/env docker-node

const AmiClient = require('asterisk-ami-client');
const client = new AmiClient({
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

client
        .on('connect', () => console.log('connect'))
        .on('event', event => console.log('event', event))
        .on('data', chunk => console.log('chunk', chunk))
        .on('response', response => console.log('response', response))
        .on('disconnect', () => console.log('disconnect'))
        .on('reconnection', () => console.log('reconnection'))
        .on('internalError', error => console.log('internalError', error));

(async () => {
    try {
        let result = await client.connect(ami_user, ami_password, {host: ami_host, port: 5038});
        console.log(result);

        setTimeout(() => {
            client.disconnect();
        }, 50000);

    } catch(error) {
        console.log(error.name,error.message);
    }
})();
