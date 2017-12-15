var express = require('express');
var http = require('http');
var https = require('https');
var path = require('path');
var server = require('socket.io');
var pty = require('pty.js');
var fs = require('fs');
var jwt = require('jsonwebtoken');
var Docker = require('dockerode');

var Loader = require('yaml-config-loader');
var yargs = require('yargs');
var loader = new Loader();
'use strict';

var ms = require('ms');
var config = require('./lib/config');

process.title = 'probo-shell';

config.load(function(error, config) {
  var app = express();
  var io;

  if (error) {
    throw error;
  }

  process.on('uncaughtException', function(e) {
      console.error(e);
  });

  app.get('/wetty/ssh/:user', function(req, res) {
      res.sendfile(__dirname + '/public/wetty/index.html');
  });
  app.use('/', express.static(path.join(__dirname, 'public')));

  // @TODO enable ssh
  if (false) {
      httpserv = https.createServer(config.ssl, app).listen(config['server.port'], function() {
          console.log('https on port ' + config['server.port']);
      });
  } else {
      httpserv = http.createServer(app).listen(config['server.port'], function() {
          console.log('http on port ' + config['server.port']);
      });
  }

  io = server(httpserv,{path: '/wetty/socket.io'});

  io.on('connection', function(socket){
    var request = socket.request;
    var token;
    var term;

    // @TODO remove this; this is just for testing.
    token = {
      containerNamePrefix: 'probo',
      projectSlug: 'dzink/straightlampin',
      projectId: '33978ed6-f5da-4e21-aa8b-067ae3573a66',
      buildId: 'fd402906-7895-4590-8753-90a22b8b5d84',
    };
    token = `${token.containerNamePrefix}--${token.projectSlug.replace('/', '.')}--${token.projectId}--${token.buildId}`;

    token = jwt.sign({
      data: token,
    }, config.shellSecret, {
      expiresIn: '1h',
    });

    console.log('new token', token);

    try {
      var containerName;
      var docker = Docker(config.dockerConfig);
      var matches;
      var shellAuthQueryRegex;

      shellAuthQueryRegex = new RegExp(config.shellAuthQuery + '=\(\[\\w\\d\\.\]*\)', '');
      if (matches = request.headers.referer.match(shellAuthQueryRegex)) {
        token = matches[1];
        console.log(token);
        containerName = jwt.verify(token, config.shellSecret).data;
      }
      else {
        throw new Error('Authentication token missing.')
      }

      /**
       * Kick off a shell instance.
       */
      var next = function(err, container) {
        try {
          if (err) {
            throw new Error('Error while connecting: ' . err);
          }

          term = pty.spawn('/usr/bin/env', ['docker', 'exec', '-it', container.Id, 'bash'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
          });

          term.on('data', function(data) {
              socket.emit('output', data);
          });
          term.on('exit', function(code) {
              console.log((new Date()) + " PID=" + term.pid + " ENDED")
          });
          socket.on('resize', function(data) {
              term.resize(data.col, data.row);
          });
          socket.on('input', function(data) {
              term.write(data);
          });
          socket.on('disconnect', function() {
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
          console.log(containers);
          if (containers.length == 0) {
            throw new Error('Container not found');
          }
          container = containers[0];
          console.log(container);
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
      console.log(e);
      console.log(err);
      socket.emit('output', err);
      socket.write('output', err);
      return false;
    }
  });
});
