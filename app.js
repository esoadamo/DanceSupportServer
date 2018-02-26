const app = require('express')();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const moment = require('moment');
const uuid = require('uuid/v4');
const sqlite3 = require('sqlite3').verbose();

const PORT = 3000; // server port
const db = new sqlite3.Database('datab.db');
const SESSION_TIMEOUT = 1; // minutes

let timerRemoveOldSessions;

const User = function(rowid, username, uid) {
  this.username = username;
  this.rowid = rowid;
  this.uid = uid;
}

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
          console.log(data);
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
              let stmnt2 = db.prepare("INSERT INTO `login_sessions`(`uid`,`secret`,'timeout') VALUES (?,?,?);",
                thisClient.user.uid,
                thisClient.secret,
                ((new Date()).getTime() / 1000) + (SESSION_TIMEOUT * 60)
              );
              stmnt2.run();
              stmnt2.finalize();
              thisClient.socket.emit('loginOK', {
                'uid': thisClient.user.uid,
                'secret': thisClient.secret
              });
            });
            stmnt.finalize();
          });
        });
        break;
    }
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
});

http.listen(PORT, function() {
  console.log(`Live on http://localhost:${PORT}`);
});

/**
 * Removes login sesstion that had timed out
 * @type {Timer}
 */
timerRemoveOldSessions = setInterval(()=>{
    db.serialize(() => { db.run("DELETE FROM login_sessions WHERE timeout < ?", (new Date()).getTime() / 1000);} );
}, SESSION_TIMEOUT * 60 * 1000);
