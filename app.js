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
var log = bunyan.createLogger({name: 'probo-shell', level: 'info',
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

  io.on('connection', function(socket){
    var request = socket.request;
    var token;
    var term;
    var containerName;

    // @TODO remove this; this is just for testing.
    token = {
      containerNamePrefix: 'probo',
      projectSlug: 'dzink/straightlampin',
      projectId: '33978ed6-f5da-4e21-aa8b-067ae3573a66',
      buildId: 'fd402906-7895-4590-8753-90a22b8b5d84',
      userName: 'dzink',
    };
    token.containerName = `${token.containerNamePrefix}--${token.projectSlug.replace('/', '.')}--${token.projectId}--${token.buildId}`;

    newToken = jwt.sign({
      data: JSON.stringify(token),
    }, config.shellSecret, {
      expiresIn: '1h',
    });

    log.info('new token', newToken);

    try {
      var loginData;
      var containerName;
      var docker = Docker(config.dockerConfig);
      var matches;
      var shellAuthQueryRegex;
      var keylogger = '';

      // Get the token from the current request _GET.
      shellAuthQueryRegex = new RegExp(config.shellAuthQuery + '=\(\[\\w\\d\\.\]*\)', '');
      if (matches = request.headers.referer.match(shellAuthQueryRegex)) {
        var token;
        token = matches[1];
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

          term = pty.spawn('/usr/bin/env', ['docker', 'exec', '-it', container.Id, 'bash'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
          });

          log.info('Connected to docker', loginData, 'PID ' + term.pid);

          term.on('data', function(data) {
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
