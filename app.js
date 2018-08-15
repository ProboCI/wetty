var bunyan = require('bunyan');
var Docker = require('dockerode');
var express = require('express');
var http = require('http');
var https = require('https');
var Loader = require('yaml-config-loader');
var path = require('path');
var server = require('socket.io');
var pty = require('pty.js');
var fs = require('fs');
var jwt = require('jsonwebtoken');
var yargs = require('yargs');

var loader = new Loader();
'use strict';

var ms = require('ms');
var config = require('./lib/config');
var log = bunyan.createLogger({name: 'probo-shell', level: 'debug',
  streams: [{
    stream: process.stdout
  }]});
process.title = 'probo-shell';

config.load(function(error, config) {
  var app = express();
  var io;

  if (error) {
    throw error;
  }

  process.on('uncaughtException', function(e) {
    log.error(e);
  });

  app.get('/wetty/ssh/:user', function(req, res) {
    res.sendfile(__dirname + '/public/wetty/index.html');
  });
  app.use('/', express.static(path.join(__dirname, 'public')));

  httpserv = http.createServer(app).listen(config['server.port'], function() {
    log.info('http on port ' + config['server.port']);
  });

  io = server(httpserv,{path: '/wetty/socket.io'});

  function getQuery(query, request) {
    // Get the token from the current request _GET.
    queryRegex = new RegExp(query + '=\(\[\\w-\\d\\.\]*\)', '');
    if (matches = request.headers.referer.match(queryRegex)) {
      return matches[1];
    }
    return false;
  }

  function getOperation(request, dockerCommandArray) {
    var operationName = getQuery('op', request);
    var operationCommandArray;
    operationName = operationName || 'bash';
    if (config.operations.hasOwnProperty(operationName)) {

      // Need to use slice() to copy the config, as it will be changed.
      operationCommandArray = config.operations[operationName].slice();
    }
    else {
      throw new Exception('Unknown command ' . operationName);
    }
    operationCommandArray = operationAddTailLength(operationCommandArray, request);
    operationCommandArray = operationAddWatchdogLength(operationCommandArray, request);

    // Need to use slice() to copy the docker command, as it will be changed.
    operationCommandArray = dockerCommandArray.slice().concat(operationCommandArray);
    return operationCommandArray;
  }

  function operationAddTailLength(operationCommandArray, request) {
    var logLength;
    if (operationCommandArray[0] == 'tail' && (logLength = getQuery('log-length', request))) {
      operationCommandArray.splice(1, 0, '-n');
      if (logLength == 'all') {
        operationCommandArray.splice(2, 0, '+1');
      }
      else {
        operationCommandArray.splice(2, 0, logLength);
      }
    }
    return operationCommandArray;
  }

  function operationAddWatchdogLength(operationCommandArray, request) {
    var logLength;
    if (operationCommandArray[2] == 'watchdog-show' && (logLength = getQuery('log-length', request))) {
      operationCommandArray.splice(3, 0, '--count');
      operationCommandArray.splice(4, 0, logLength);
    }
    log.info(operationCommandArray);
    return operationCommandArray;
  }

  function sanitizeData(data) {
    for (var n in config.sanitizeStrings) {
      var replacement = config.sanitizeStrings[n].replacement || '<*****>';
      var regex = new RegExp(config.sanitizeStrings[n].pattern, 'gi');;
      data = data.replace(regex, replacement);
    }
    return data;
  }

  io.on('connection', function(socket){
    var request = socket.request;
    var token;
    var term;
    var containerName;

    try {
      var loginData;
      var containerName;
      var docker = Docker(config.dockerConfig);
      var matches;
      var shellAuthQueryRegex;
      var keylogger = '';

      // Get the token from the current request _GET.
      if (token = getQuery(config.shellAuthQuery, request)) {
        loginData = jwt.verify(token, config.shellSecret).data;
        loginData = JSON.parse(loginData);
        containerName = loginData.containerName;
      }
      else {
        throw new Error('Authentication token missing.')
      }

      /**
       * Kick off a shell instance.
       */
      var next = function(err, container) {
        var logString = '';
        try {
          if (err) {
            throw new Error('Error while connecting: ' . err);
          }

          dockerCommandArray = getOperation(request, ['docker', 'exec', '-it', container.Id]);

          term = pty.spawn('/usr/bin/env', dockerCommandArray, {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
          });

          log.info('Connected to docker', loginData, 'PID ' + term.pid);

          term.on('data', function(data) {
            log.info(data);
            data = sanitizeData(data, config.sanitizeStrings);
            log.info(data);
            logString = logString.concat(data);
            socket.emit('output', data);
          });
          term.on('exit', function(code) {
            log.info('Probo-Shell Log:', 'Date: ' + (new Date()), loginData, logString);
            log.info('exit', container.Id);
          });
          socket.on('resize', function(data) {
            term.resize(data.col, data.row);
          });
          socket.on('input', function(data) {
            term.write(data);
          });
          socket.on('disconnect', function() {
            log.info('Probo-Shell Log:', 'Date: ' + (new Date()), loginData, logString);
            log.info('disconnect', container.Id);
            term.end();
          });

        }
        catch (e) {
          throw new Error('Problem connecting to Probo.ci shell: ' + (e.message));
        }
      };

      /**
       * Get the container referenced in the JWT.
       */
      docker.listContainers({all: true, size: false}, function(err, containers) {
        var container;
        try {
          if (err) throw Error(err);

          function proboFilter(containerInfo) {
            // .Names is an array, and first name in array is the main name
            // container names in docker start with a /, so look for our prefix
            // starting with second character (index 1)
            return containerInfo.Names[0].indexOf(containerName) === 1;
          }

          containers = containers.filter(proboFilter);
          if (containers.length == 0) {
            throw new Error('Container not found');
          }
          container = containers[0];
        }
        catch (e) {
          throw new Error('Could not connect to Docker instance: ' + e.message);
        }
        if (container.State != 'running') {
          try {
            var containerObject = docker.getContainer(container.Id);
            containerObject.start(function(err, data) {
              next(null, container);
            });
          }
          catch (e) {
            throw new Error('Could not start Docker instance.');
          }
        }
        else {
          next(null, container);
        }
      });
    } catch (e) {
      var err;
      if (e.name === 'JsonWebTokenError') {
        err = ('Authentication token invalid.');
      }
      if (e.name === 'TokenExpiredError') {
        err = ('Authentication token expired.');
      }
      err = err || e.message;
      socket.emit('output', err);
      socket.write('output', err);
      return false;
    }
  });
});
