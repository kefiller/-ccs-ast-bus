#!/bin/bash

# Detect where script SOURCE is located
SCRIPT_ORIGPATH=`readlink -f "$(test -L "$0" && readlink "$0" || echo "$0")"`
SCRIPT_ORIGDIR=`dirname $SCRIPT_ORIGPATH`

docker run -t --rm  -w /app \
    --name=ccs-ast-bus \
    --network=host \
    -v $SCRIPT_ORIGDIR:/app \
    -e AMI_HOST='localhost' \
    -e AMI_USER=api \
    -e AMI_PASSWORD='Fgbitxrf18' \
    node:latest node index.js $@
