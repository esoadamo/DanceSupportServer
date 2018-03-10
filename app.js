const app = require('express')();
const http = require('http').Server(app);
const io = require('socket.io')(http, {origins: '*:*'});
const moment = require('moment');
const uuid = require('uuid/v4');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const PORT = 3000; // server port
const db = new sqlite3.Database('datab.db');
const SESSION_TIMEOUT = 1; // minutes

let timerRemoveOldSessions;
let onlineUsers = {};  // key is uid, value is list with Client objects

const User = function(rowid, username, uid) {
  this.username = username;
  this.rowid = rowid;
  this.uid = uid;
  this.friends = {}; // key is uid, value is {"username": value, "online": bool}
}

const FileRecivier = function(socket, allowUploads=true) {
  let socketListeners = [];
  let newUploadsAllowed = allowUploads;

  socket.on('newUpload', (data) => {
    if (!newUploadsAllowed){
      socket.emit('uploadFailed', {file: 'file' in data ? data.file : '', reason: 'File uploads are disabled'});
      return;
    }

  });

  this.setAllow = (bool) => {
    this.newUploadsAllowed = bool;
  };
  this.close = () => {
    for (let listenerName of socketListeners)
      socket.removeAllListeners(listenerName);
  };
};

const Client = function(socket) {
  this.socket = socket;
  this.status = ClientStatus.unknown;
  this.name = '';
  this.user = null;
  this.secret = null;

  let statusRelatedActiveListeners = [];
  let thisClient = this;

  this.changeStatus = (newStatus) => {
    for (let listenerName of statusRelatedActiveListeners)
      this.socket.removeAllListeners(listenerName);
    this.status = newStatus;
    switch (newStatus) {
      case ClientStatus.unknown:
        statusRelatedActiveListeners.push('login');
        this.socket.on('login', (data) => {
          if (!(data instanceof Object) || !('username' in data) || !('password' in data)) {
            thisClient.socket.emit('loginFailed', 'Missing data');
            return;
          }
          db.serialize(() => {
            let stmnt = db.prepare("SELECT rowid, uid FROM users WHERE username=? AND password=?", data.username, data.password);
            stmnt.get(function(err, row) {
              if (row === undefined) {
                thisClient.socket.emit('loginFailed', 'Wrong username/password');
                return;
              }
              thisClient.user = new User(row.rowid, data.username, row.uid);
              thisClient.changeStatus(ClientStatus.loggedIn);
              thisClient.secret = uuid();
              /*let stmnt2 = db.prepare("INSERT INTO `login_sessions`(`uid`,`secret`,'timeout') VALUES (?,?,?);",
                thisClient.user.uid,
                thisClient.secret,
                ((new Date()).getTime() / 1000) + (SESSION_TIMEOUT * 60)
              );
              stmnt2.run();
              stmnt2.finalize();  TODO Implement in the future*/
              thisClient.socket.emit('loginOK', {
                'uid': thisClient.user.uid,
                'secret': thisClient.secret
              });
              thisClient.socket.join(thisClient.user.uid);
              if (thisClient.user.uid in Object.keys(onlineUsers))
                onlineUsers[thisClient.user.uid].push(thisClient);
              else
                onlineUsers[thisClient.user.uid] = [thisClient];
              console.log(thisClient.user.username + ' joined.');
              console.log('Online clients: ' + Object.keys(onlineUsers));
            });
            stmnt.finalize();
          });
        });
        break;
      case ClientStatus.loggedIn:
        statusRelatedActiveListeners.push('getFriends');
        this.socket.on('getFriends', () => {
          db.serialize(() => {
            db.all(`SELECT username, uid FROM users INNER JOIN friendships ON
                    (users.rowid == friendships.urow1 AND friendships.urow2 == ?)
                    OR (users.rowid == friendships.urow2 AND friendships.urow1 == ?)`, [thisClient.user.rowid, thisClient.user.rowid], (err, rows) => {
                        thisClient.user.friends = {};
                        for (let row of rows)
                            thisClient.user.friends[row.uid] = {username: row.username, online: row.uid in onlineUsers};
                        thisClient.socket.emit('friendsList', thisClient.user.friends);
                    });
          });
        });
        this.socket.on('challenge', (uid) => {
            if (!(uid in this.user.friends)){
                this.socket.emit('challengeDeclined', 'This user is not your friend.');
                return;
            }
            if (!(uid in onlineUsers)){
                this.socket.emit('challengeDeclined', 'User is offline');
                return;
            }
            console.log('challenging');
            io.to(uid).emit('challenge', thisClient.user.uid);
        });
    };

    this.disconnect = () => {
      if ((this.user !== null) && (this.user.uid !== null) && (this.user.uid in onlineUsers))
        delete onlineUsers[this.user.uid]
    };
  }

  // Initialize listeners
  this.changeStatus(this.status);
}

const ClientStatus = {
  unknown: 0,
  loggedIn: 1
}

app.get('*', function(req, res) {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', function(socket) {
  let client = new Client(socket);
  socket.on('disconnect', client.disconnect);
});

http.listen(PORT, function() {
  console.log(`Live on http://localhost:${PORT}`);
});

/**
 * Removes login sesstion that had timed out
 * @type {Timer}
 *//* TODO Not Implemented yet
timerRemoveOldSessions = setInterval(()=>{
    db.serialize(() => { db.run("DELETE FROM login_sessions WHERE timeout < ?", (new Date()).getTime() / 1000);} );
}, SESSION_TIMEOUT * 60 * 1000);*/
