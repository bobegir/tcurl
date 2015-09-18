#!/usr/bin/env node

// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

/*eslint no-process-exit: 0*/
'use strict';

var TChannel = require('tchannel');
var TChannelAsThrift = require('tchannel/as/thrift');
var TChannelAsJSON = require('tchannel/as/json');
var minimist = require('minimist');
var myLocalIp = require('my-local-ip');
var DebugLogtron = require('debug-logtron');

var fmt = require('util').format;
var console = require('console');
var process = require('process');
var fs = require('fs');
var path = require('path');
var url = require('url');
var assert = require('assert');

var safeJsonParse = require('safe-json-parse/tuple');

var Logger = require('./log');
var TCurlAsHttp = require('./as-http');

var packageJson = require('./package.json');

main.exec = execMain;

module.exports = main;

var minimistArgs = {
    boolean: ['raw'],
    alias: {
        h: 'help',
        p: 'peer',
        H: 'hostlist',
        t: 'thrift',
        2: ['arg2', 'head'],
        3: ['arg3', 'body'],
        j: ['J', 'json']
    },
    default: {
        head: '',
        body: '',
        strict: true
    }
};

if (require.main === module) {
    main(minimist(process.argv.slice(2), minimistArgs));
}

function execMain(str, cb) {
    main(minimist(str, minimistArgs), cb);
}

function help() {
    var helpMessage = [
        'tcurl [-H <hostlist> | -p host:port] <service> <endpoint> [options]',
        '  ',
        '  Version: ' + packageJson.version,
        '  Options: ',
        // TODO @file; @- stdin.
        '    -2 [data] send an arg2 blob',
        '    -3 [data] send an arg3 blob',
        '    --shardKey send ringpop shardKey transport header',
        '    --depth=n configure inspect printing depth',
        '    -j print JSON',
        '    -J [indent] print JSON with indentation',
        '    -t [dir] directory containing Thrift files',
        '    --http method',
        '    --raw encode arg2 & arg3 raw',
        '    --health',
        '    --timeout [num]'
    ].join('\n');
    console.log(helpMessage);
    return;
}

function parseArgs(argv) {
    var service = argv._[0];
    var endpoint = argv._[1];
    var health = argv.health;

    var uri = argv.hostlist ?
        JSON.parse(fs.readFileSync(argv.hostlist))[0] : argv.peer;

    var parsedUri = url.parse('tchannel://' + uri);

    if (parsedUri.hostname === 'localhost') {
        parsedUri.hostname = myLocalIp();
    }

    assert(parsedUri.hostname, 'host required');
    assert(parsedUri.port, 'port required');
    assert(health || endpoint, 'endpoint required');
    assert(service, 'service required');
    var logger = Logger(argv);

    if (!parseJsonArgs(argv, logger)) {
        return null;
    }

    return {
        head: argv.head,
        body: argv.body,
        shardKey: argv.shardKey,
        service: service,
        endpoint: endpoint,
        hostname: parsedUri.hostname,
        port: parsedUri.port,
        thrift: argv.thrift,
        http: argv.http,
        json: argv.json,
        raw: argv.raw,
        timeout: argv.timeout,
        depth: argv.depth,
        health: health,
        logger: logger
    };
}

function main(argv, onResponse) {
    /*eslint no-console: 0 */
    if (argv.help || argv._.length === 0) {
        return help();
    }

    var opts = parseArgs(argv);

    tcurl(opts, onResponse);
}

function reportError(logger, message, err) {
    logger.display('error', message, {
        error: {
            message: err.message,
            type: err.type,
            arguments: err.arguments,
            name: err.name
        }
    });
}

function jsonParseError(logger, message, json, err) {
    logger.display('error', message + ' It should be JSON formatted.', {
        JSON: json,
        exitCode: -1,
        error: {
            message: err.message,
            type: err.type,
            arguments: err.arguments,
            name: err.name
        }
    });
}

function parseJsonArgs(opts, logger) {
    if (opts.raw) {
        return true;
    }

    var tuple = null;
    if (opts.body) {
        tuple = safeJsonParse(opts.body);
        opts.body = tuple[1] || opts.body;
    }
    if (tuple && tuple[0]) {
        jsonParseError(logger,
            'Failed to JSON parse arg3 (i.e. request body).',
            opts.body,
            tuple[0]);
        return false;
    }

    tuple = null;
    if (opts.head) {
        tuple = safeJsonParse(opts.head);
        opts.head = tuple[1] || opts.head;
    }
    if (tuple && tuple[0]) {
        jsonParseError(logger,
            'Failed to JSON parse arg2 (i.e. request head).',
            opts.head,
            tuple[0]);
        return false;
    }

    return true;
}

function readThriftSpec(opts) {
    try {
        return fs.readFileSync(opts.thrift, 'utf8');
    } catch(err) {
        if (err.code !== 'EISDIR') {
            reportError(opts.logger, 'Failed to read thrift file "' +
                opts.thrift + '"', err);
            return null;
        }
    }

    return readThriftSpecDir(opts);
}

function readThriftSpecDir(opts) {
    var specs = {};
    var files = fs.readdirSync(opts.thrift);
    files.forEach(function eachFile(file) {
        var match = /([^\/]+)\.thrift$/.exec(file);
        if (match) {
            var serviceName = match[1];
            var fileName = match[0];
            var thriftFilepath = path.join(opts.thrift, fileName);
            specs[serviceName] = fs.readFileSync(thriftFilepath, 'utf8');
        }
    });

    if (!specs[opts.service]) {
        var err = new Error('Spec for service "' +
            opts.service + '" unavailable in directory "' + opts.thrift + '"');
        reportError(opts.logger, err.message, err);
        return null;
    }

    return specs[opts.service];
}

function tcurl(opts, callback) {
    callback = callback || defaultCallback;

    if (opts === null) {
        // failed to parse options, printed error, exit with 1
        return callback({exitCode: 1});
    }

    var logger = opts.logger || new Logger(opts);

    var client = TChannel({
        logger: DebugLogtron('tcurl')
    });

    var subChan = client.makeSubChannel({
        serviceName: opts.service,
        peers: [opts.hostname + ':' + opts.port],
        requestDefaults: {
            serviceName: opts.service,
            headers: {
                cn: 'tcurl'
            }
        }
    });

    client.waitForIdentified({
        host: opts.hostname + ':' + opts.port
    }, onIdentified);

    function onIdentified(err) {
        if (err) {
            return onResponse(err);
        }

        var headers = opts.shardKey ? {sk: opts.shardKey} : {};

        var request = subChan.request({
            timeout: opts.timeout || 100,
            hasNoParent: true,
            serviceName: opts.service,
            headers: headers
        });

        if (opts.health) {
            opts.thrift = path.join(__dirname, 'meta.thrift');
            opts.endpoint = 'Meta::health';
        }

        if (opts.thrift) {
            asThrift(opts, request, onResponse);
        } else if (opts.raw) {
            asRaw(opts, request, onResponse);
        } else if (opts.http) {
            asHTTP(opts, client, subChan, onResponse, logger);
        } else {
            asJSON(opts, request, onResponse);
        }
    }

    function onResponse(err, resp, arg2, arg3) {
        client.quit();

        if (arg2 !== undefined && resp) {
            resp.head = arg2;
        }
        if (arg3 !== undefined && resp) {
            resp.body = arg3;
        }

        if (opts.health) {
            healthCallback(err, resp);
        } else {
            callback(err, resp, arg2, arg3);
        }
    }

    function healthCallback(err, resp) {
        var msg;
        var isHealthy = null;

        if (err || !resp || !resp.ok || !resp.body.ok) {
            msg = 'notOk';
            isHealthy = false;
            if (resp && resp.body && resp.body.message) {
                msg += '\n' + resp.body.message;
            }
        } else {
            msg = 'ok';
            isHealthy = true;
        }

        logger.log('log', msg);
        callback({exitCode: isHealthy ? 0 : 1}, resp);
    }

    function defaultCallback(err, resp) {
        if (err && err.exitCode !== undefined) {
            process.exit(err.exitCode);
        }

        if (err) {
            logger.displayResponse('error',
                'Got an error response', err);
            process.exit(1);
        } else if (!resp.ok) {
            logger.displayResponse('error',
                'Got call response not ok', resp.body);
            process.exit(1);
        } else {
            logger.displayResponse('log',
                'Got call response ok', resp.body);
        }
    }
}

function asThrift(opts, request, onResponse) {
    var spec = readThriftSpec(opts);

    var sender = new TChannelAsThrift({source: spec});
    if (spec === null) {
        return onResponse({exitCode: 1});
    }

    // The following is a hack to produce a nice error message when
    // the endpoint does not exist. It is a temporary solution based
    // on the thriftify interface. How the existence of this endpoint
    // is checked and this error thrown will change when we move to
    // the thriftrw rewrite.
    try {
        sender.send(request, opts.endpoint, opts.head,
            opts.body, onResponse);
    } catch (e) {
        if (e.message ===
            fmt('type %s_args not found', opts.endpoint)) {
            var emsg = fmt('%s endpoint does not exist', opts.endpoint);
            onResponse(new Error(emsg));
        } else {
            var msg = e.message || '';
            reportError(opts.logger,
                'Error response received for the as-thrift request. '
                + msg, e);
            return onResponse(e);
        }
    }
}

function asRaw(opts, request, onResponse) {
    request.headers.as = 'raw';
    request.send(opts.endpoint, opts.head, opts.body,
        onResponse);
}

function asHTTP(opts, client, subChan, onResponse, logger) {
    var ashttp = TCurlAsHttp({
        channel: client,
        subChannel: subChan,
        method: opts.http,
        endpoint: opts.endpoint,
        headers: opts.head,
        body: opts.body,
        onResponse: onResponse,
        logger: logger
    });
    ashttp.send();
}

function asJSON(opts, request, onResponse) {
    var sender = new TChannelAsJSON();
    sender.send(request, opts.endpoint, opts.head,
        opts.body, onResponse);
}
