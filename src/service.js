import { Redis } from '@upstash/redis';
import AsyncLock from 'async-lock';
import { AccessError, InputError } from './error.js';

const lock = new AsyncLock();

// Redis initialization
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DATA_KEY = 'bigbrain:data';

let admins = {};
let games = {};
let sessions = {};

// Initialize data from Redis (run only once)
(async () => {
  try {
    const data = await redis.get(DATA_KEY);
    if (data) {
      admins = data.admins || {};
      games = data.games || {};
      sessions = data.sessions || {};
    } else {
      console.log("⚠️ No data found in Redis, initializing new DB");
      save();
    }
  } catch (err) {
    console.error("Failed to load data from Redis:", err);
  }
})();

// Save data to Redis
const update = (newAdmins, newGames, newSessions) =>
  new Promise((resolve, reject) => {
    lock.acquire("saveData", async () => {
      try {
        await redis.set(DATA_KEY, {
          admins: newAdmins,
          games: newGames,
          sessions: newSessions,
        });
        resolve();
      } catch (error) {
        reject(new Error("Writing to Redis failed"));
      }
    });
  });

export const save = () => update(admins, games, sessions);

// ------------------ Function logic ------------------

export function register(email, password, name) {
  if (admins[email]) throw new InputError("Account already exists");
  admins[email] = { password, name };
  return save();
}

export function login(email, password) {
  const user = admins[email];
  if (!user || user.password !== password) {
    throw new AccessError("Invalid login credentials");
  }
  return `${email}:${Date.now()}`;
}

export function logout(token) {
  return; // No persistent sessions in this version
}

export function getEmailFromAuthorization(authHeader) {
  if (!authHeader) throw new AccessError("No auth header");
  const [email] = authHeader.split(':');
  if (!admins[email]) throw new AccessError("Invalid user");
  return email;
}

export function getAnswers(sessionId, playerId) {
  const session = sessions[sessionId];
  if (!session || !session.players[playerId]) return [];
  return session.players[playerId].answers || [];
}

export function getGamesFromAdmin(email) {
  return Object.values(games).filter(game => game.owner === email);
}

export function updateGamesFromAdmin(email, gameId, data) {
  if (!games[gameId] || games[gameId].owner !== email) {
    throw new AccessError("Not your game");
  }
  games[gameId] = { ...games[gameId], ...data };
  return save();
}

export function assertOwnsGame(email, gameId) {
  if (!games[gameId] || games[gameId].owner !== email) {
    throw new AccessError("Not your game");
  }
}

export function assertOwnsSession(email, sessionId) {
  const session = sessions[sessionId];
  if (!session || games[session.gameId].owner !== email) {
    throw new AccessError("Not your session");
  }
}

export function mutateGame(gameId, mutationType) {
  if (mutationType === "START") {
    const sessionId = Math.floor(Math.random() * 1000000);
    sessions[sessionId] = {
      gameId,
      position: -1,
      isoTimeLastQuestionStarted: null,
      players: {},
    };
    save();
    return sessionId;
  }

  throw new InputError("Invalid mutation type");
}

export function getQuestion(sessionId, playerId) {
  const session = sessions[sessionId];
  if (!session) throw new InputError("Session not found");

  const game = games[session.gameId];
  if (!game) throw new InputError("Game not found");

  if (session.position === -1) return null;

  const q = game.questions[session.position];
  return {
    questionId: q.questionId,
    question: q.text,
    duration: q.duration,
    answers: q.answers.map(a => a.text),
  };
}

export function submitAnswers(sessionId, playerId, answerIds) {
  const session = sessions[sessionId];
  if (!session || session.position === -1) {
    throw new InputError("Session not active");
  }

  if (!session.players[playerId]) {
    session.players[playerId] = { answers: {}, score: 0 };
  }

  session.players[playerId].answers[session.position] = answerIds;
  save();
}

export function playerJoin(sessionId, name) {
  const session = sessions[sessionId];
  if (!session) throw new InputError("Invalid session");
  const playerId = Math.random().toString(36).substring(2, 10);
  session.players[playerId] = { name, answers: {}, score: 0 };
  save();
  return playerId;
}

export function sessionStatus(sessionId, playerId) {
  const session = sessions[sessionId];
  if (!session) throw new InputError("Session not found");

  return {
    started: session.position !== -1,
    ended: session.position >= games[session.gameId].questions.length,
  };
}

export function sessionResults(sessionId) {
  const session = sessions[sessionId];
  if (!session) throw new InputError("Session not found");
  return session.players;
}
