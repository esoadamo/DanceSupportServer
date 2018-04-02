const app = require('express')();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  origins: '*:*'
});
const moment = require('moment');
const uuid = require('uuid/v4');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = 8476; // server port
const db = new sqlite3.Database('datab.db');
const SESSION_TIMEOUT = 1; // minutes
const folderSongs = 'songs'; // folder where the songs will be saved

let timerRemoveOldSessions;
let onlineUsers = {}; // key is uid, value is list with Client objects

const User = function(rowid, username, uid) {
  this.username = username;
  this.rowid = rowid;
  this.uid = uid;
  this.friends = {}; // key is uid, value is {"username": value, "online": bool}
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
                thisClient.user.friends[row.uid] = {
                  username: row.username,
                  online: row.uid in onlineUsers
                };
              thisClient.socket.emit('friendsList', thisClient.user.friends);
            });
          });
        });
        this.socket.on('challenge', (data) => {
          if (!('seconds' in data) || !('songId' in data) || !('uid' in data)) {
            this.socket.emit('challengeDeclined', 'Incomplete request');
            return;
          }
          if (!(data.uid in this.user.friends)) {
            this.socket.emit('challengeDeclined', 'This user is not your friend.');
            return;
          }
          if (!(data.uid in onlineUsers)) {
            this.socket.emit('challengeDeclined', 'User is offline');
            return;
          }
          io.to(data.uid).emit('challenge', {
            uid: thisClient.user.uid,
            songId: data.songId,
            seconds: data.seconds
          });
        });

        this.socket.on('isUploaded', (songId) => {
          thisClient.socket.emit('uploadStatus', fs.existsSync(path.join(folderSongs, path.basename(songId))));
        });

        this.socket.on('upload', (data) => {
          if (!('hash' in data) || !('data' in data)) {
            return;
          }
          fs.writeFile(path.join(folderSongs, path.basename(data.hash)), data.data, function(err) {
            if (err)
              return console.log('Error during saving a song: ' + err);
            thisClient.socket.emit('uploadStatus', !err);
          });
        });

        this.socket.on('startPlaying', (data) => {
          if (!('yourId' in data) || !('seconds' in data)) {
            return;
          }
          io.to(data.yourId).emit('startPlaying', {
            seconds: data.seconds,
            uid: thisClient.user.uid
          });
        });

        this.socket.on('challengeUpdate', (data) => {
          if (!('yourId' in data) || !('message' in data)) {
            return;
          }
          io.to(data.yourId).emit('challengeUpdate', {
            message: data.message,
            uid: thisClient.user.uid
          });
        });

        this.socket.on('challengeDeclined', (declinedUid) => {
          io.to(declinedUid).emit('challengeDeclined', 'I am busy right now');
        });
    };

    this.disconnect = () => {
      // remove this client from online users instance
      if ((this.user !== null) && (this.user.uid !== null) && (this.user.uid in onlineUsers)) {
        let currentClientIndex = onlineUsers[this.user.uid].indexOf(thisClient);
        if (currentClientIndex !== -1)
          onlineUsers[this.user.uid].slice(currentClientIndex, 1);
      }
    };
  }

  // Initialize listeners
  this.changeStatus(this.status);
}

const ClientStatus = {
  unknown: 0,
  loggedIn: 1
}

if (!fs.existsSync(folderSongs))
  fs.mkdirSync(folderSongs);

app.get('/song/:hash', function(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(path.resolve(path.join(folderSongs, path.basename(req.params.hash))));
});

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
 */
/* TODO Not Implemented yet
timerRemoveOldSessions = setInterval(()=>{
    db.serialize(() => { db.run("DELETE FROM login_sessions WHERE timeout < ?", (new Date()).getTime() / 1000);} );
}, SESSION_TIMEOUT * 60 * 1000);*/
