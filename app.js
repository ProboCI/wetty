var express = require('express');
var http = require('http');
var https = require('https');
var path = require('path');
var server = require('socket.io');
var pty = require('pty.js');
var fs = require('fs');
var jwt = require('jsonwebtoken');
var Docker = require('dockerode');


var dockerConfig = {
  socketPath: '/var/run/docker.sock',
}
var shellSecret = 'coolSecret';

var opts = require('optimist')
    .options({
        config: {
            demand: true,
            alias: 'c',
            description: 'config file location',
        },
        port: {
            demand: true,
            alias: 'p',
            description: 'wetty listen port'
        },
    }).boolean('allow_discovery').argv;

var runhttps = false;
var sshport = 22;
var sshhost = '127.0.0.0';
var sshauth = 'password,keyboard-interactive';
var globalsshuser = '';

process.on('uncaughtException', function(e) {
    console.error('Error: ' + e);
});

var httpserv;

var app = express();
app.get('/wetty/ssh/:user', function(req, res) {
    res.sendfile(__dirname + '/public/wetty/index.html');
});
app.use('/', express.static(path.join(__dirname, 'public')));

if (runhttps) {
    httpserv = https.createServer(opts.ssl, app).listen(opts.port, function() {
        console.log('https on port ' + opts.port);
    });
} else {
    httpserv = http.createServer(app).listen(opts.port, function() {
        console.log('http on port ' + opts.port);
    });
}

var io = server(httpserv,{path: '/wetty/socket.io'});

// @TODO here we should ping back the probo app to get
io.on('connection', function(socket){
  var sshuser = '';
  var sshpass = 'vagrant';
  var request = socket.request;
  var token;

  // For now, spit out a token I can use to test.
  token = {
    containerNamePrefix: 'probo',
    projectSlug: 'dzink/straightlampin',
    projectId: '33978ed6-f5da-4e21-aa8b-067ae3573a66',
    buildId: 'fd402906-7895-4590-8753-90a22b8b5d84',
  };

  token = jwt.sign({
    data: token,
  }, shellSecret, {
    expiresIn: '1h',
  });

  console.log(token);
  try {
    var term;
    var containerName;
    var docker = Docker(dockerConfig);

    token = request.headers.referer.match(/abcd=([\w\d\.]*)/)[1];;
    token = jwt.verify(token, shellSecret).data;

    containerName = `${token.containerNamePrefix}--${token.projectSlug.replace('/', '.')}--${token.projectId}--${token.buildId}`;

    /**
     * Kick off a shell instance.
     */
    var next = function(err, container) {
      try {
        if (err) {
          throw new Error('Error while connecting: ' . err);
        }

        if (sshpass) {
          globalsshuser += ':' + sshpass;
        }
        console.log((new Date()) + ' Connection accepted.');
        if (match = request.headers.referer.match('/wetty/ssh/.+$')) {
            sshuser = match[0].replace('/wetty/ssh/', '') + '@';
        } else if (globalsshuser) {
            sshuser = globalsshuser + '@';
        }
        throw new Error("Input is not a number.");
        pty.spawn('/usr/bin/env', ['docker', 'start', container.Id], {
          name: 'xterm-256color',
          cols: 80,
          rows: 30,
        });
        term = pty.spawn('/usr/bin/env', ['docker', 'exec', '-it', container.Id, 'bash'], {
          name: 'xterm-256color',
          cols: 80,
          rows: 30,
        });

        console.log((new Date()) + " PID=" + term.pid + " STARTED on behalf of user=" + sshuser)
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
        if (!containers) {
          next('It is brokern');
        }
        container = containers[0];
      }
      catch (e) {
        throw new Error('Could not find Docker instance. ' + e.message);
      }
      next(null, container);
    });

  } catch (e) {
    var err;
    if (e.name ==  'JsonWebTokenError') {
      err = ('Token missing, invalid, or expired. Please refresh the build page and try again');
    }
    err = err || e.message;
    console.log(err);
    socket.emit('output', err);
    socket.write(err);
    console.log('problems');
    return err;
  }
});
