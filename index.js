const functions = require("firebase-functions");
const admin = require('firebase-admin');
const jsChessEngine = require('js-chess-engine')
const Client = require('ssh2-sftp-client');
var fs = require('fs')
const path = require('path');


// file paths
const dest = path.resolve(__dirname, './file.dat')
const src = path.resolve(__dirname, './GNDMOVE.dat');
// const dest = path.join(__dirname, '.', 'file.dat');
// const src = path.join(__dirname, '.', 'GNDMOVE.dat');


// when deploy change to ( admin.initializeApp() )
const serviceAccount = require("./permit.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://hydrachess-e9dcd-default-rtdb.europe-west1.firebasedatabase.app",
  storageBucket: "gs://hydrachess-e9dcd.appspot.com"
});


const database = admin.firestore();

// config for sftp connection
const config = {
  host: "access875030600.webspace-data.io",
  username: "u183377867",
  password: "chessftp2022",
}

/*
sendStatus -> get the most voted move and send the move to the ground station via sftp
Schedule function (runs every 12 hours)
*/
exports.sendStatus = functions.pubsub.schedule("0 */12 * * *").onRun(async (context) => {
  await sendStatusProcedure();
  return 0;
});

/*
sendStatusProcedure -> get the most voted move and send the move to the ground station via sftp 
*/
const sendStatusProcedure = async () => {
  // rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR
  var docRef = database.collection("chess").doc("ChessBoardStatus");
  var out = false;
  await docRef.get().then((doc) => {
    if (doc.exists) {
      if (doc.data().turn == 'b') {
        out = true; // we are still waiting for the satellite
      }
    }
  }).catch((err) => console.log(err));

  console.log('linea 49');
  if (out) return 0;

  var fenToLoad = '';
  await docRef.get().then((doc) => {
    if (doc.exists) {
      fenToLoad = doc.data().status;
    }
  });

  fenToLoad += ' w KQkq - 0 1';
  var game = new jsChessEngine.Game(fenToLoad);

  console.log('linea 62')
  // count votes
  const voteRef = database.collection('votes').doc('dailyVote');
  const doc = await voteRef.get();

  const data = doc.data();
  vote = getVote(data);

   // if there is no votes...
  if (vote == null) {
    
    var move = game.aiMove(4); // level 4, max difficulty
    key = Object.keys(move)[0];
    vote = `${key}_${move[key]}`;

  } else { game.move(vote.split('_')[0], vote.split('_')[1]); }


  // check if it is check-mate; if so, restart the game (this is not our task)
  // if (game.exportJson().checkMate) {
  //     // c.load('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
  //     game = new jsChessEngine.Game('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  // }

  console.log('vote is: ' + vote);

  // update database
  database.doc("chess/ChessBoardStatus").update({
    "status": game.exportFEN().split(' ')[0],
    "turn": "b",
  }).catch((err) => console.log(err));

  // reset all votes
  await resetVotes();

  // send package
  // - create package
  // - save package in src file
  // - uploadd src file to /GNDMOVE.dat
  await uploadFile(vote.split('_')[0], vote.split('_')[1]);  

}

/* 
  getVote -> get the voted movement made by the users, 
  @param {Object} data, contains the votes {movement : frec }
    - movement: A2_A3 (example)
    - fec: number of times voted

  return values:
    if there is any vote:
      return movement (string)
    else
      return null;
*/
const getVote = (data) => {
  keys = Object.keys(data); // get moves (A2_A3, B1_C3,...)
  keys = keys.filter((a) => a != 'status') // Do not take the field status
  
  var max = 0;
  var vote = null;

  // find the max value in the map & save the key (move)
  for (let key of keys) {
    if (data[key] > max) {
      vote = key;
      max = data[key];
    }
  }

  return vote;
}

/*
  uploadFile -> put the package in the groundstation via sftp
  @params {String, String} from , to
    - from: source square
    - to: target square
*/
const uploadFile = async (from, to) => {

  cad = createPackage(from, to);
  fs.writeFile(src, cad, 'binary', () => {});

  const sftp = new Client();

  await sftp.connect(config).then(() => {
    let toPut = fs.createReadStream(src);
    return sftp.put(toPut, '/GNDMOVE.dat');
  }).then(data => {
      console.log('GNDMOVE.dat sended!');
  }).catch(err => {
      console.log('Could not upload\n', err);
  }).finally(() => sftp.end());
}


/*
getStatus -> update the database by retrieving the SATBOARD.dat file from the target (sftp host)
Schedule function (runs every hour at minute 0)
*/
exports.getStatus = functions.pubsub.schedule("0 * * * *").onRun(async (context) => {
  const sftp = new Client();

  await sftp.connect(config).then(() => {
    return sftp.fastGet('/SATBOARD.dat', dest);
  }).then(data => {
    fs.readFile(dest, async (err, d) => {
      const board = toFen(d.toString('hex'));
      database.doc("chess/ChessBoardStatus").update({
        "status": board,
        "turn": "w",
      });

      sftp.rename('./SATBOARD.dat', renameFile());
    })
  }).catch(err => {
    console.log('Error function getStatus: ' + err);
  }).finally(() => sftp.end());

  return 0;
});


// auxiliary functions

/* 
  resetVotes -> reset all user votes and delete the doc "votes/dailyVote"
*/
const resetVotes = async () => {
  await database.collection("users").get()
    .then((querySnapshot) => {
      querySnapshot.forEach((el) => {
        // doc.data() is never undefined for query doc snapshots
        database.collection("users").doc(el.id).update({
          "vote": "",
          "limit" : 3,
        });
      });
    }).catch((err) => console.log('Reset: ' + err));

  await database.collection("votes").doc("dailyVote").delete().then(() => console.log('deleted'));

  await database.collection("votes").doc("dailyVote").set({
    status: "active"
  })
  .then(() => console.log('success'))
  .catch((err) => console.log('status active: ' + err));

}

/*
renameFile -> return a string like the following'./SATBOARD_YYMMDD_hhmmss'
Y - year, M - month, D - day
h - hour, m - minute, s - second
*/
const renameFile = () => {
  const tzoffset = (new Date()).getTimezoneOffset() * 60000;
  const localISOTime = (new Date(Date.now() - tzoffset)).toISOString().split(/[^0-9]/).slice(0, -1);

  a = [localISOTime.slice(0, 3).join(''), localISOTime.slice(3, 6).join('')]

  return './SATBOARD_' + a.join('_');
}

/*
  createPackage -> return a CodePoint String (binary) given movement
  @param {String} from (sourceSquare)
  @param {String} to (targetSquare)
*/
const createPackage = (from, to) => {
  a = from[0].toUpperCase().charCodeAt(0) - 64
  b = to[0].toUpperCase().charCodeAt(0) - 64

  cad = String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) + 
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0xa7) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(0x00) +
  String.fromCodePoint(+('0x'+`${Number(a)}${Number(from[1])}`)) +
  String.fromCodePoint(+('0x'+`${Number(b)}${Number(to[1])}`)) +
  String.fromCodePoint(0x35) +
  String.fromCodePoint(0x99)

  return cad;
}

/*
  toFen -> return chessboard notation, FEN, given a certain package
  @param {String} data (SATBOARD.dat hexdump parse to string)
*/
const toFen = (data) => {

  data = data.substring(22, 86)
  const PB = '1'; const TB = '2'; const CB = '3';
  const AB = '4'; const DB = '5'; const RB = '6';
  const PN = '7'; const TN = '8'; const CN = '9';
  const AN = 'a'; const DN = 'b'; const RN = 'c';

  let fen = ""
  let cont = 1;
  for (let letter of data) {
    if (letter == PB) fen += 'P'
    if (letter == TB) fen += 'R'
    if (letter == CB) fen += 'N'
    if (letter == AB) fen += 'B'
    if (letter == DB) fen += 'Q'
    if (letter == RB) fen += 'K'
    if (letter == PN) fen += 'p'
    if (letter == TN) fen += 'r'
    if (letter == CN) fen += 'n'
    if (letter == AN) fen += 'b'
    if (letter == DN) fen += 'q'
    if (letter == RN) fen += 'k'
    if (letter == '0') fen += '1'
    if (cont == 0) fen += '/'

    cont = (cont + 1) % 8;
  }

  fen = fen.substring(0, fen.length - 1);
  const regex = /11111111/gi;
  return fen.replace(regex, '8')
}



// ************************************
// test functions (DO NOT DEPLOY THESE)
// ************************************

// exports.retrieveBinary = functions.pubsub.schedule("0 0 * * *").onRun(async (context) => {
//   const sftp = new Client();

//   await sftp.connect(config).then(() => {
//     return sftp.fastGet('/GNDMOVE.dat', dest);
//   }).then(data => {
//     fs.readFile(dest, async (err, d) => {
//       console.log('hex:\n' + d.toString('hex'));
//       // console.log('bin:\n' + parseInt(d.toString(2), 2));
//     })
//   }).catch(err => {
//     console.log('Error function sendStatus: ' + err);
//   }).finally(() => sftp.end());

//   return 0;
// });

// exports.writeBin = functions.pubsub.schedule("0 0 * * *").onRun(async (context) => {
//   const sftp = new Client();
  
//   cad = createPackage('c2','c3');
//   fs.writeFile(src, cad, 'binary', () => {});
//   await sftp.connect(config).then(() => {
//     let toPut = fs.createReadStream(src);
//     return sftp.put(toPut, '/GNDMOVE.dat');
//   }).then(data => {
//       console.log('fast put done');
//   }).catch(err => {
//       console.log('Could not upload\n', err);
//   }).finally(() => sftp.end());
//   // fs.readFile(src, (err, d) => {
//   //   console.log(d)
//   //   console.log('hex:\n' + d.toString('hex'));
//   // });

//   return 0;
// });