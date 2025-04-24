import AsyncLock from "async-lock";
import fs from "fs";
import jwt from "jsonwebtoken";
import { AccessError, InputError } from "./error";

const lock = new AsyncLock();

const JWT_SECRET = "llamallamaduck";
const DATABASE_FILE = "./database.json";

/***************************************************************
                      State Management
***************************************************************/

let admins = {};
let games = {};
let sessions = {};

const sessionTimeouts = {};

const update = (admins, games, sessions) =>
  new Promise((resolve, reject) => {
    lock.acquire("saveData", () => {
      try {
        fs.writeFileSync(
          DATABASE_FILE,
          JSON.stringify(
            {
              admins,
              games,
              sessions,
            },
            null,
            2
          )
        );
        resolve();
      } catch {
        reject(new Error("Writing to database failed"));
      }
    });
  });

export const save = () => update(admins, games, sessions);
export const reset = () => {
  update({}, {}, {});
  admins = {};
  games = {};
  sessions = {};
};

try {
  const data = JSON.parse(fs.readFileSync(DATABASE_FILE));
  admins = data.admins;
  games = data.games;
  sessions = data.sessions;
} catch {
  console.log("WARNING: No database found, create a new one");
  save();
}

/***************************************************************
                      Helper Functions
***************************************************************/

const newSessionId = (_) => generateId(Object.keys(sessions), 999999);
const newPlayerId = (_) =>
  generateId(
    Object.keys(sessions).map((s) => Object.keys(sessions[s].players))
  );

export const userLock = (callback) =>
  new Promise((resolve, reject) => {
    lock.acquire("userAuthLock", callback(resolve, reject));
  });

export const gameLock = (callback) =>
  new Promise((resolve, reject) => {
    lock.acquire("gameMutateLock", callback(resolve, reject));
  });

export const sessionLock = (callback) =>
  new Promise((resolve, reject) => {
    lock.acquire("sessionMutateLock", callback(resolve, reject));
  });

const copy = (x) => JSON.parse(JSON.stringify(x));
const randNum = (max) =>
  Math.round(
    Math.random() * (max - Math.floor(max / 10)) + Math.floor(max / 10)
  );
const generateId = (currentList, max = 999999999) => {
  let R = randNum(max);
  while (currentList.includes(R)) {
    R = randNum(max);
  }
  return R.toString();
};

/***************************************************************
                      Auth Functions
***************************************************************/

export const getEmailFromAuthorization = (authorization) => {
  try {
    const token = authorization.replace("Bearer ", "");
    const { email } = jwt.verify(token, JWT_SECRET);
    if (!(email in admins)) {
      throw new AccessError("Invalid Token");
    }
    return email;
  } catch {
    throw new AccessError("Invalid token");
  }
};

export const login = (email, password) =>
  userLock((resolve, reject) => {
    if (email in admins) {
      if (admins[email].password === password) {
        admins[email].sessionActive = true;
        resolve(jwt.sign({ email }, JWT_SECRET, { algorithm: "HS256" }));
      }
    }
    reject(new InputError("Invalid username or password"));
  });

export const logout = (email) =>
  userLock((resolve, reject) => {
    admins[email].sessionActive = false;
    resolve();
  });

export const register = (email, password, name) =>
  userLock((resolve, reject) => {
    if (email in admins) {
      return reject(new InputError("Email address already registered"));
    }
    admins[email] = {
      name,
      password,
      sessionActive: true,
    };
    const token = jwt.sign({ email }, JWT_SECRET, { algorithm: "HS256" });
    resolve(token);
  });

/***************************************************************
                      Game Functions
***************************************************************/

export const assertOwnsGame = (email, gameId) =>
  gameLock((resolve, reject) => {
    if (!(gameId in games)) {
      return reject(new InputError("Invalid game ID"));
    } else if (games[gameId].owner !== email) {
      return reject(new InputError("Admin does not own this Game"));
    } else {
      resolve();
    }
  });

export const getGamesFromAdmin = (email) =>
  gameLock((resolve, reject) => {
    const filteredGames = Object.keys(games)
      .filter((key) => games[key].owner === email)
      .map((key) => {
        const game = games[key] || {};
        return {
          ...(game || {}),
          id: parseInt(key, 10),
          active: getActiveSessionIdFromGameId(key),
          oldSessions: getInactiveSessionsIdFromGameId(key),
        };
      });
    resolve(filteredGames);
  });

export const updateGamesFromAdmin = ({ gamesArrayFromRequest, email }) =>
  gameLock((resolve, reject) => {
    try {
      // Get all existing game IDs owned by other admins
      const otherAdminGameIds = Object.keys(games).filter(
        (gameId) => games[gameId].owner !== email
      );

      // Verify all games in array belong to admin
      for (const gameFromRequest of gamesArrayFromRequest) {
        if (!gameFromRequest.owner) {
          return reject(
            new InputError(`Game must have owner: ${gameFromRequest.owner}`)
          );
        }
        if (gameFromRequest.owner !== email) {
          return reject(
            new InputError("Cannot modify games owned by other admins")
          );
        }
      }

      // Convert array to object format and update
      const newGames = {};
      gamesArrayFromRequest.forEach((gameFromRequest) => {
        const gameIdFromRequest = gameFromRequest.id || gameFromRequest.gameId || gameFromRequest.gameID;
        // If game has an ID and it exists in admin's games, use that ID
        // Otherwise generate a new ID
        const gameId =
          gameIdFromRequest &&
          otherAdminGameIds.includes(gameIdFromRequest.toString()) === false
            ? gameIdFromRequest.toString()
            : generateId(Object.keys(games));

        //
        newGames[gameId] = {
          owner: gameFromRequest.owner,
          // Preserve active session ID & old sessions
          active: getActiveSessionIdFromGameId(gameId),
          oldSessions: getInactiveSessionsIdFromGameId(gameId),
          ...gameFromRequest,
        };
      });

      // Only update games owned by this admin, preserve others
      Object.keys(games).forEach((gameId) => {
        if (games[gameId].owner !== email) {
          newGames[gameId] = games[gameId];
        }
      });

      games = newGames;
      save(); // Save to database after update
      resolve();
    } catch (error) {
      reject(new Error("Failed to update games"));
    }
  });

export const startGame = (gameId) =>
  gameLock((resolve, reject) => {
    if (gameHasActiveSession(gameId)) {
      return reject(new InputError("Game already has active session"));
    } else {
      const id = newSessionId();
      sessions[id] = newSessionPayload(gameId);
      resolve(id);
    }
  });

export const advanceGame = (gameId) =>
  gameLock((resolve, reject) => {
    const session = getActiveSessionFromGameIdThrow(gameId);
    if (!session.active) {
      return reject(new InputError("Cannot advance a game that is not active"));
    } else {
      const totalQuestions = session.questions.length;
      session.position += 1;
      session.answerAvailable = false;
      session.isoTimeLastQuestionStarted = new Date().toISOString();
      if (session.position >= totalQuestions) {
        endGame(gameId);
      } else {
        try {
          const questionDuration = session.questions.at(
            session.position
          ).duration;
          if (sessionTimeouts[session.id]) {
            clearTimeout(sessionTimeouts[session.id]);
          }
          sessionTimeouts[session.id] = setTimeout(() => {
            session.answerAvailable = true;
          }, questionDuration * 1000);
        } catch (error) {
          reject(new InputError("Question duration not found"));
        }
      }
      resolve(session.position);
    }
  });

export const endGame = (gameId) =>
  gameLock((resolve, reject) => {
    const session = getActiveSessionFromGameIdThrow(gameId);
    session.active = false;
    resolve();
  });

export const mutateGame = async ({ gameId, mutationType }) => {
  let result;
  try {
    switch (mutationType.toUpperCase()) {
      case "START":
        const sessionId = await startGame(gameId);
        result = { status: "started", sessionId };
        break;
      case "ADVANCE":
        const position = await advanceGame(gameId);
        result = { status: "advanced", position };
        break;
      case "END":
        await endGame(gameId);
        result = { status: "ended" };
        break;
      default:
        throw new InputError("Invalid mutation type");
    }
    return result;
  } catch (error) {
    throw error instanceof InputError
      ? error
      : new Error("Failed to mutate game: " + error.message);
  }
};

/***************************************************************
                      Session Functions
***************************************************************/

const gameHasActiveSession = (gameId) =>
  Object.keys(sessions).filter(
    (s) => sessions[s].gameId === gameId && sessions[s].active
  ).length > 0;

const getActiveSessionFromGameIdThrow = (gameId) => {
  if (!gameHasActiveSession(gameId)) {
    throw new InputError("Game has no active session");
  }
  const sessionId = getActiveSessionIdFromGameId(gameId);
  if (sessionId !== null) {
    return sessions[sessionId];
  }
  return null;
};

const getActiveSessionIdFromGameId = (gameId) => {
  const activeSessions = Object.keys(sessions).filter(
    (s) => sessions[s].gameId === gameId && sessions[s].active
  );
  if (activeSessions.length === 1) {
    return parseInt(activeSessions[0], 10);
  }
  return null;
};

const getInactiveSessionsIdFromGameId = (gameId) =>
  Object.keys(sessions)
    .filter((sid) => sessions[sid].gameId === gameId && !sessions[sid].active)
    .map((s) => parseInt(s, 10));

const getActiveSessionFromSessionId = (sessionId) => {
  if (sessionId in sessions) {
    if (sessions[sessionId].active) {
      return sessions[sessionId];
    }
  }
  throw new InputError("Session ID is not an active session");
};

const sessionIdFromPlayerId = (playerId) => {
  for (const sessionId of Object.keys(sessions)) {
    if (
      Object.keys(sessions[sessionId].players).filter((p) => p === playerId)
        .length > 0
    ) {
      return sessionId;
    }
  }
  throw new InputError("Player ID does not refer to valid player id");
};

const newSessionPayload = (gameId) => ({
  gameId,
  position: -1,
  isoTimeLastQuestionStarted: null,
  players: {},
  questions: copy(games[gameId].questions),
  active: true,
  answerAvailable: false,
});

const newPlayerPayload = (name, numQuestions) => ({
  name: name,
  answers: Array(numQuestions).fill({
    questionStartedAt: null,
    answeredAt: null,
    answers: [],
    correct: false,
  }),
});

export const sessionStatus = (sessionId) => {
  const session = sessions[sessionId];
  return {
    active: session.active,
    answerAvailable: session.answerAvailable,
    isoTimeLastQuestionStarted: session.isoTimeLastQuestionStarted,
    position: session.position,
    questions: session.questions,
    players: Object.keys(session.players).map(
      (player) => session.players[player].name
    ),
  };
};

export const assertOwnsSession = async (email, sessionId) => {
  await assertOwnsGame(email, sessions[sessionId].gameId);
};

export const sessionResults = (sessionId) =>
  sessionLock((resolve, reject) => {
    const session = sessions[sessionId];
    if (session.active) {
      return reject(new InputError("Cannot get results for active session"));
    } else {
      resolve(Object.keys(session.players).map((pid) => session.players[pid]));
    }
  });

export const playerJoin = (name, sessionId) =>
  sessionLock((resolve, reject) => {
    if (name === undefined) {
      return reject(new InputError("Name must be supplied"));
    } else {
      const session = getActiveSessionFromSessionId(sessionId);
      if (session.position >= 0) {
        return reject(new InputError("Session has already begun"));
      } else {
        const id = newPlayerId();
        session.players[id] = newPlayerPayload(name, session.questions.length);
        resolve(parseInt(id, 10));
      }
    }
  });

export const hasStarted = (playerId) =>
  sessionLock((resolve, reject) => {
    const session = getActiveSessionFromSessionId(
      sessionIdFromPlayerId(playerId)
    );
    if (session.isoTimeLastQuestionStarted !== null) {
      resolve(true);
    } else {
      resolve(false);
    }
  });

export const getQuestion = (playerId) =>
  sessionLock((resolve, reject) => {
    const session = getActiveSessionFromSessionId(
      sessionIdFromPlayerId(playerId)
    );
    if (session.position === -1) {
      return reject(new InputError("Session has not started yet"));
    } else {
      try {
        const question = session.questions.at(session.position);
        const { correctAnswers, ...questionWithoutAnswer } = question;
        const questionWithSessionInfo = {
          ...questionWithoutAnswer,
          isoTimeLastQuestionStarted: session.isoTimeLastQuestionStarted,
        };
        resolve(questionWithSessionInfo);
      } catch (error) {
        reject(new InputError("Question not found"));
      }
    }
  });

export const getAnswers = (playerId) =>
  sessionLock((resolve, reject) => {
    const session = getActiveSessionFromSessionId(
      sessionIdFromPlayerId(playerId)
    );
    if (session.position === -1) {
      return reject(new InputError("Session has not started yet"));
    } else if (!session.answerAvailable) {
      return reject(new InputError("Answers are not available yet"));
    } else {
      try {
        const answers = session.questions.at(session.position).correctAnswers;
        resolve(answers);
      } catch (error) {
        reject(new InputError("Question not found"));
      }
    }
  });

export const submitAnswers = (playerId, answersFromRequest) =>
  sessionLock((resolve, reject) => {
    if (answersFromRequest === undefined || answersFromRequest.length === 0) {
      return reject(new InputError("Answers must be provided"));
    }

    const session = getActiveSessionFromSessionId(
      sessionIdFromPlayerId(playerId)
    );
    if (session.position === -1) {
      return reject(new InputError("Session has not started yet"));
    } else if (session.answerAvailable) {
      return reject(
        new InputError("Can't answer question once answer is available")
      );
    } else {
      const currentQuestion = session.questions[session.position];
      session.players[playerId].answers[session.position] = {
        questionStartedAt: session.isoTimeLastQuestionStarted,
        answeredAt: new Date().toISOString(),
        answers: answersFromRequest,
        correct:
          JSON.stringify(currentQuestion.correctAnswers.sort()) ===
          JSON.stringify(answersFromRequest.sort()),
      };
      resolve();
    }
  });

export const getResults = (playerId) =>
  sessionLock((resolve, reject) => {
    const session = sessions[sessionIdFromPlayerId(playerId)];
    if (session.active) {
      return reject(
        new InputError("Session is ongoing, cannot get results yet")
      );
    } else if (session.position === -1) {
      return reject(new InputError("Session has not started yet"));
    } else {
      resolve(session.players[playerId].answers);
    }
  });
