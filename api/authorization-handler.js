const config = require("../models/config"),
  storage = require("../logic/storage"),
  roles = require("../models/user/roles"),
  { verifySignature } = require("../util/signer"),
  errors = require("../util/errors"),
  { encodeUrlParams } = require("../util/url-encoder");

const scheme = "ed25519 ";

function getDefaultAdmin() {
  return {
    pubkey: null,
    roles: [roles.ADMIN],
  };
}

function isInRole(req, role) {
  return req.user && req.user.roles && req.user.roles.indexOf(role) >= 0;
}

function canEdit(req, resourceOwnerPubKey) {
  return (
    req.user &&
    (isInRole(req, roles.ADMIN) || req.user.pubkey === resourceOwnerPubKey)
  );
}

function userMiddleware(req, res, next) {
  req.user = null;
  if (!config.authorization || config.authorization === "disabled") {
    req.user = getDefaultAdmin();
    return next();
  }
  let token = req.headers["x-access-token"] || req.headers["authorization"];
  if (token && token.startsWith(scheme)) {
    token = token.slice(scheme.length, token.length);
  }

  if (!token) return next();
  if (token === config.adminAuthenticationToken) {
    req.user = getDefaultAdmin();
    return next();
  }

  const [pubkey, signature] = token.split(".");

  let payload, nonce;
  if (req.method === "GET") {
    nonce = Number(req.query.nonce);
    payload = encodeUrlParams(req.query);
  } else {
    payload = encodeUrlParams(req.body);
    nonce = Number(req.body.nonce);
  }

  if (nonce && !isNaN(nonce) && payload) {
    if (verifySignature(pubkey, payload, signature)) {
      let userProvider = storage.provider.userProvider;
      userProvider
        .getUserByPublicKey(pubkey)
        .then((user) => {
          if (user) return user;
          return userProvider
            .addUser({
              pubkey,
              roles: [],
            })
            .then(() => userProvider.getUserByPublicKey(pubkey));
        })
        .then((user) => {
          if (user && user.nonce < nonce) {
            return userProvider.updateNonce(user.id, nonce).then((res) => {
              if (res)
                req.user = {
                  pubkey: user.pubkey,
                  roles: user.roles,
                };
            });
          }
        })
        .then(next);
    }
  }
}

function userRequiredMiddleware(req, res, next) {
  if (!req.user) return next(errors.unauthorized());
  next();
}

function isInRoleMiddleware(role) {
  return function (req, res, next) {
    if (!req.user || req.user.roles.indexOf(role) === -1)
      return next(errors.forbidden());
    next();
  };
}

module.exports = {
  userMiddleware,
  userRequiredMiddleware,
  isInRoleMiddleware,
  canEdit,
  isInRole,
};
