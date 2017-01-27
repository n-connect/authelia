
var objectPath = require('object-path');
var randomstring = require('randomstring');
var Promise = require('bluebird');
var util = require('util');
var exceptions = require('./exceptions');

module.exports = identity_check;


// IdentityCheck class

function IdentityCheck(user_data_store, email_sender, logger) {
  this._user_data_store = user_data_store;
  this._email_sender = email_sender;
  this._logger = logger;
}

IdentityCheck.prototype.issue_token = function(userid, email, content, logger) {
  var five_minutes = 4 * 60 * 1000;
  var token = randomstring.generate({ length: 64 });
  var that = this;

  this._logger.debug('identity_check: issue identity token %s for 5 minutes', token);
  return this._user_data_store.issue_identity_check_token(userid, token, content, five_minutes)
  .then(function() {
    that._logger.debug('identity_check: send email to %s', email);
    return that._send_identity_check_email(email, token);
  })
}

IdentityCheck.prototype._send_identity_check_email = function(email, token) {
  var url = util.format('%s?identity_token=%s', email.hook_url, token); 
  var email_content = util.format('<a href="%s">Register</a>', url);
  return this._email_sender.send(email.to, email.subject, email_content);
}

IdentityCheck.prototype.consume_token = function(token, logger) {
  this._logger.debug('identity_check: consume token %s', token);
  return this._user_data_store.consume_identity_check_token(token)
}


// The identity_check middleware that allows the user two perform a two step validation
// using the user email

function identity_check(app, endpoint, icheck_interface) {
  app.get(endpoint, identity_check_get(endpoint, icheck_interface)); 
  app.post(endpoint, identity_check_post(endpoint, icheck_interface)); 
}


function identity_check_get(endpoint, icheck_interface) {
  return function(req, res) {
    var logger = req.app.get('logger');
    var identity_token = objectPath.get(req, 'query.identity_token');
    logger.info('GET identity_check: identity token provided is %s', identity_token);

    if(!identity_token) {
      res.status(403);
      res.send();
      return;
    }

    var email_sender = req.app.get('email sender');
    var user_data_store = req.app.get('user data store');
    var identity_check = new IdentityCheck(user_data_store, email_sender, logger);

    identity_check.consume_token(identity_token, logger)
    .then(function(content) {
      objectPath.set(req, 'session.auth_session.identity_check', {});
      req.session.auth_session.identity_check.challenge = icheck_interface.challenge;
      req.session.auth_session.identity_check.userid = content.userid;
      res.render(icheck_interface.render_template);
    }, function(err) {
      logger.error('GET identity_check: Error while consuming token %s', err);
      throw new exceptions.AccessDeniedError('Access denied');
    })
    .catch(exceptions.AccessDeniedError, function(err) {
      logger.error('GET identity_check: Access Denied %s', err);
      res.status(403);
      res.send();
    })
    .catch(function(err) {
      logger.error('GET identity_check: Internal error %s', err);
      res.status(500);
      res.send();
    });
  }
}


function identity_check_post(endpoint, icheck_interface) {
  return function(req, res) {
    var logger = req.app.get('logger');
    var email_sender = req.app.get('email sender');
    var user_data_store = req.app.get('user data store');
    var identity_check = new IdentityCheck(user_data_store, email_sender, logger);
    var userid, email_address;

    icheck_interface.pre_check_callback(req)
    .then(function(identity) {
      email_address = objectPath.get(identity, 'email');
      userid = objectPath.get(identity, 'userid');
      if(!(email_address && userid)) {
        throw new exceptions.IdentityError('Missing user id or email address');
      }

      var email = {};
      email.to = email_address;
      email.subject = 'Identity Verification';
      email.hook_url = util.format('https://%s%s', req.headers.host, req.headers['x-original-uri']);
      return identity_check.issue_token(userid, email, undefined, logger);
    }, function(err) {
      throw new exceptions.AccessDeniedError('Access denied');
    })
    .then(function() {
      res.status(204);
      res.send();
    })
    .catch(exceptions.IdentityError, function(err) {
      logger.error('POST identity_check: %s', err);
      res.status(400);
      res.send();
      return;
    })
    .catch(exceptions.AccessDeniedError, function(err) {
      logger.error('POST identity_check: %s', err);
      res.status(403);
      res.send();
      return;
    })
    .catch(function(err) {
      logger.error('POST identity_check: %s', err);
      res.status(500);
      res.send();
    });
  }
}


