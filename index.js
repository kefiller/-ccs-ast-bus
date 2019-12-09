#!/usr/bin/env docker-node

const {isNil, some} = require('lodash');
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

if (some([ami_host, ami_user, ami_password], isNil) ) {
    console.log('Some of AMI_* env variables not set');
    process.exit(1);
}

client
        .on('connect', () => console.log(`connected to ${ami_host}`))
        .on('event', event => console.log('event', event))
        .on('response', response => console.log('response', response))
        .on('disconnect', () => console.log(`disconnected from ${ami_host}`))
        .on('reconnection', () => console.log(`reconnection to ${ami_host}`))
        .on('internalError', error => console.log('internalError', error));

(async () => {
    try {
        // await client.connect(ami_user, ami_password, {host: ami_host, port: 5038});

        setTimeout(() => {
            client.disconnect();
        }, 50000);

    } catch(error) {
        console.log(error.name,error.message);
    }
})();
