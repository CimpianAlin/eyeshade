var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var crypto = require('crypto')
var currencyCodes = require('currency-codes')
var dns = require('dns')
var Joi = require('joi')
var underscore = require('underscore')
var url = require('url')
var uuid = require('uuid')

var v1 = {}

var prefix1 = 'brave-ledger-verification'
var prefix2 = prefix1 + '='

/*
   POST /v1/publishers
*/

v1.bulk = {
  handler: (runtime) => {
    return async (request, reply) => {
      const payload = request.payload
      const authority = request.auth.credentials.provider + ':' + request.auth.credentials.profile.username
      const reportId = uuid.v4().toLowerCase()
      const reportURL = url.format(underscore.defaults({ pathname: '/v1/reports/file/' + reportId }, runtime.config.server))
      const debug = braveHapi.debug(module, request)
      const publishers = runtime.db.get('publishers', debug)
      const tokens = runtime.db.get('tokens', debug)
      let publisher, state

      for (let entry of payload) {
        publisher = await publishers.findOne({ publisher: entry.publisher, verified: true })
        if (publisher) return reply(boom.badData('publisher ' + entry.publisher + ' already verified'))
      }

      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: { verified: true, reason: 'bulk loaded', authority: authority }
      }
      for (let entry of payload) {
        entry.verificationId = uuid.v4().toLowerCase()
        underscore.extend(state.$set, { verificationId: entry.verificationId, token: entry.verificationId })
        await tokens.update({ publisher: entry.publisher }, state, { upsert: true })
      }

      await runtime.queue.send(debug, 'publishers-bulk-create',
                               underscore.defaults({ reportId: reportId, reportURL: reportURL, authority: authority },
                                                   { publishers: payload }, request.query))
      reply({ reportURL: reportURL })
    }
  },

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Creates publisher entries in bulk',
  tags: [ 'api' ],

  validate: {
    query: { format: Joi.string().valid('json', 'csv').optional().default('json').description('the format of the report') },
    payload: Joi.array().min(1).items(Joi.object().keys({
      publisher: braveJoi.string().publisher().required().description('the publisher identity'),
      name: Joi.string().min(1).max(40).required().description('contact name'),
      email: Joi.string().email().required().description('contact email'),
      phone: Joi.string().regex(/^\+(?:[0-9][ -]?){6,14}[0-9]$/).required().description('contact phone number'),
      show_verification_status: Joi.boolean().optional().default(true).description('authorizes display')
    }).unknown(true)).required().description('publisher settlement report')
  },

  response: {
    schema: Joi.object().keys({
      reportURL: Joi.string().uri({ scheme: /https?/ }).optional().description('the URL for a forthcoming report')
    }).unknown(true)
  }
}

/*
   POST /v1/publishers/settlement/{hash}
 */

v1.settlement = {
  handler: (runtime) => {
    return async (request, reply) => {
      var entry, i, state
      var hash = request.params.hash
      var payload = request.payload
      var debug = braveHapi.debug(module, request)
      var settlements = runtime.db.get('settlements', debug)

      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: { hash: hash }
      }
      for (i = 0; i < payload.length; i++) {
        entry = payload[i]

        underscore.extend(state.$set, underscore.pick(entry, [ 'address', 'satoshis', 'fees' ]))
        await settlements.update({ settlementId: entry.transactionId, publisher: entry.publisher }, state, { upsert: true })
      }

      reply({})
    }
  },

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Posts a settlement for one or more publishers',
  tags: [ 'api' ],

  validate: {
    params: { hash: Joi.string().hex().required().description('transaction hash') },
    payload: Joi.array().min(1).items(Joi.object().keys({
      publisher: braveJoi.string().publisher().required().description('the publisher identity'),
      address: braveJoi.string().base58().required().description('BTC address'),
      satoshis: Joi.number().integer().min(1).required().description('the settlement in satoshis'),
      transactionId: Joi.string().guid().description('the transactionId')
    }).unknown(true)).required().description('publisher settlement report')
  },

  response:
    { schema: Joi.object().length(0) }
}

/*
   GET /v1/publishers/{publisher}/balance
 */

v1.getBalance = {
  handler: (runtime) => {
    return async (request, reply) => {
      var amount, entry, rate, satoshis, summary
      var publisher = request.params.publisher
      var currency = request.query.currency
      var debug = braveHapi.debug(module, request)
      var settlements = runtime.db.get('settlements', debug)
      var voting = runtime.db.get('voting', debug)

      summary = await voting.aggregate([
        {
          $match:
          {
            satoshis: { $gt: 0 },
            publisher: { $eq: publisher },
            exclude: false
          }
        },
        {
          $group:
          {
            _id: '$publisher',
            satoshis: { $sum: '$satoshis' }
          }
        }
      ])
      satoshis = summary.length > 0 ? summary[0].satoshis : 0

      summary = await settlements.aggregate([
        {
          $match:
          {
            satoshis: { $gt: 0 },
            publisher: { $eq: publisher }
          }
        },
        {
          $group:
          {
            _id: '$publisher',
            satoshis: { $sum: '$satoshis' }
          }
        }
      ])
      if (summary.length > 0) satoshis -= summary[0].satoshis
      if (satoshis < 0) satoshis = 0

      rate = runtime.wallet.rates[currency.toUpperCase()]
      if (rate) {
        entry = currencyCodes.code(currency)
        amount = ((satoshis * rate) / 1e8).toFixed(entry ? entry.digits : 2)
      }
      reply({ amount: amount, currency: currency, satoshis: satoshis })
    }
  },

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Gets the balance for a verified publisher',
  tags: [ 'api' ],

  validate: {
    params: { publisher: braveJoi.string().publisher().required().description('the publisher identity') },
    query: {
      currency: braveJoi.string().currencyCode().optional().default('USD').description('the fiat currency'),
      access_token: Joi.string().guid().optional()
    }
  },

  response: {
    schema: Joi.object().keys({
      amount: Joi.number().min(0).optional().description('the balance in the fiat currency'),
      currency: braveJoi.string().currencyCode().optional().default('USD').description('the fiat currency'),
      satoshis: Joi.number().integer().min(0).optional().description('the balance in satoshis')
    })
  }
}

/*
   GET /v1/publishers/{publisher}/status
 */

v1.getStatus = {
  handler: (runtime) => {
    return async (request, reply) => {
      var entry
      var publisher = request.params.publisher
      var debug = braveHapi.debug(module, request)
      var publishers = runtime.db.get('publishers', debug)

      entry = await publishers.findOne({ publisher: publisher })
      if (!entry) return reply(boom.notFound('no such entry: ' + publisher))

      reply(underscore.pick(entry, [ 'address', 'authorized' ]))
    }
  },

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Gets the status for a verified publisher',
  tags: [ 'api' ],

  validate: {
    params: { publisher: braveJoi.string().publisher().required().description('the publisher identity') },
    query: { access_token: Joi.string().guid().optional() }
  },

  response: {
    schema: Joi.object().keys({
      address: braveJoi.string().base58().optional().description('BTC address'),
      authorized: Joi.boolean().optional().description('authorized for settlements')
    }).unknown(true).description('the publisher status')
  }
}

/*
   GET /v1/publishers/{publisher}/verifications/{verificationId}
 */

v1.getToken = {
  handler: (runtime) => {
    return async (request, reply) => {
      var entry, state, token
      var publisher = request.params.publisher
      var verificationId = request.params.verificationId
      var debug = braveHapi.debug(module, request)
      var tokens = runtime.db.get('tokens', debug)

      entry = await tokens.findOne({ verificationId: verificationId, publisher: publisher })
      if (entry) return reply({ token: entry.token })

      token = crypto.randomBytes(32).toString('hex')
      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: { token: token }
      }
      await tokens.update({ verificationId: verificationId, publisher: publisher }, state, { upsert: true })

      reply({ token: token })
    }
  },

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Gets a verification token for a publisher',
  tags: [ 'api' ],

  validate: {
    params: {
      publisher: braveJoi.string().publisher().required().description('the publisher identity'),
      verificationId: Joi.string().guid().required().description('identity of the requestor')
    },
    query: { access_token: Joi.string().guid().optional() }
  },

  response:
    { schema: Joi.object().keys({ token: Joi.string().hex().length(64).required().description('verification token') }) }
}

/*
   PUT /v1/publishers/{publisher}/wallet
 */

v1.setWallet = {
  handler: (runtime) => {
    return async (request, reply) => {
      var entry, state
      var publisher = request.params.publisher
      var bitcoinAddress = request.payload.bitcoinAddress
      var verificationId = request.payload.verificationId
      var debug = braveHapi.debug(module, request)
      var publishers = runtime.db.get('publishers', debug)
      var tokens = runtime.db.get('tokens', debug)

      entry = await tokens.findOne({ verificationId: verificationId, publisher: publisher })
      if (!entry) return reply(boom.notFound('no such entry: ' + publisher))

      if (!entry.verified) return reply(boom.badData('not verified: ' + publisher + ' using ' + verificationId))

      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: { address: bitcoinAddress }
      }
      await publishers.update({ publisher: publisher }, state, { upsert: true })

      reply({})
    }
  },

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Sets the bitcoin address for a publisher',
  tags: [ 'api' ],

  validate: {
    params: { publisher: braveJoi.string().publisher().required().description('the publisher identity') },
    query: { access_token: Joi.string().guid().optional() },
    payload: {
      bitcoinAddress: braveJoi.string().base58().required().description('BTC address'),
      verificationId: Joi.string().guid().required().description('identity of the requestor')
    }
  },

  response:
    { schema: Joi.object().length(0) }
}

/*
   PATCH /v1/publishers/{publisher}
 */

v1.patchPublisher = {
  handler: (runtime) => {
    return async (request, reply) => {
      var authority, entry, state
      var publisher = request.params.publisher
      var payload = request.payload
      var authorized = payload.authorized
      var legalFormURL = payload.legalFormURL
      var reason = payload.reason
      var debug = braveHapi.debug(module, request)
      var publishers = runtime.db.get('publishers', debug)

      if ((legalFormURL) && (legalFormURL.indexOf('void:') === 0) && (legalFormURL !== 'void:form_retry')) {
        return reply(boom.badData('invalid legalFormURL: ' + legalFormURL))
      }

      entry = await publishers.findOne({ publisher: publisher })
      if (!entry) return reply(boom.notFound('no such entry: ' + publisher))

      authority = request.auth.credentials.provider + ':' + request.auth.credentials.profile.username
      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: underscore.extend(payload, { authority: authority })
      }
      await publishers.update({ publisher: publisher }, state, { upsert: true })

      if (authorized) await notify(debug, runtime, publisher, { type: 'payments_activated' })
      if ((legalFormURL) && (legalFormURL.indexOf('void:') === 0)) {
        await publish(debug, runtime, 'patch', publisher, '/legal_form', { brave_status: 'void' })

      // void:form_retry
        await notify(debug, runtime, publisher,
                   underscore.extend({ type: legalFormURL.substr(5) },
                                     (reason && reason) ? { params: { message: reason } } : {}))
      }

      reply({})
    }
  },

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Sets the approved legal form and authorizes the publisher',
  tags: [ 'api' ],

  validate: {
    params: { publisher: braveJoi.string().publisher().required().description('the publisher identity') },
    payload: {
      authorized: Joi.boolean().optional().default(false).description('authorize the publisher'),
      legalFormURL: braveJoi.string().uri({ scheme: [ /https?/, 'void' ] }).optional().description('S3 URL'),
      reason: Joi.string().trim().optional().description('explanation for notification')
    }
  },

  response:
    { schema: Joi.object().length(0) }
}

/*
   DELETE /v1/publishers/{publisher}
 */

v1.deletePublisher = {
  handler: (runtime) => {
    return async (request, reply) => {
      var entries
      var publisher = request.params.publisher
      var debug = braveHapi.debug(module, request)
      var tokens = runtime.db.get('tokens', debug)

      entries = await tokens.find({ publisher: publisher })
      if (entries.length === 0) return reply(boom.notFound('no such entry: ' + publisher))

      if (underscore.findWhere(entries, { verified: true })) {
        return reply(boom.badData('publisher is already verified: ' + publisher))
      }

      await tokens.remove({ publisher: publisher })

      reply({})
    }
  },

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Deletes a non-verified publisher',
  tags: [ 'api' ],

  validate:
    { params: { publisher: braveJoi.string().publisher().required().description('the publisher identity') } },

  response:
    { schema: Joi.object().length(0) }
}

/*
   GET /v1/publishers/{publisher}/verify
 */

var hints = {
  standard: '/.well-known/brave-payments-verification.txt',
  root: '/'
}
var hintsK = underscore.keys(hints)

var dnsTxtResolver = async (domain) => {
  return new Promise((resolve, reject) => {
    dns.resolveTxt(domain, (err, rrset) => {
      if (err) return reject(err)
      resolve(rrset)
    })
  })
}

var webResolver = async (debug, runtime, publisher, path) => {
  debug('webResolver', { publisher: publisher, path: path })
  try {
    debug('webResolver', 'https://' + publisher + path)
    return await braveHapi.wreck.get('https://' + publisher + path,
                                     { redirects: 3, rejectUnauthorized: true, timeout: (5 * 1000) })
  } catch (ex) {
    if (((!ex.isBoom) || (!ex.output) || (ex.output.statusCode !== 504)) && (ex.code !== 'ECONNREFUSED')) {
      debug('webResolver', publisher + ': ' + ex.toString())
//    throw ex
    }
    throw ex
  }

/* http:// no longer acceptable
  debug('webResolver', 'http://' + publisher + path)
  return await braveHapi.wreck.get('http://' + publisher + path, { redirects: 3, timeout: (5 * 1000) })
 */
}

var verified = async (request, reply, runtime, entry, verified, backgroundP, reason) => {
  var message, payload, state
  var indices = underscore.pick(entry, [ 'verificationId', 'publisher' ])
  var debug = braveHapi.debug(module, request)
  var tokens = runtime.db.get('tokens', debug)

  message = underscore.extend(underscore.clone(indices), { verified: verified, reason: reason })
  debug('verified', message)
  if (/* (!backgroundP) || */ (verified)) {
    runtime.notify(debug, {
      channel: '#publishers-bot',
      text: (verified ? '' : 'not ') + 'verified: ' + JSON.stringify(message)
    })
  }

  entry.verified = verified
  if (reason.indexOf('Error: ') === 0) reason = reason.substr(7)
  if (reason.indexOf('Client request error: ') === 0) reason = reason.substr(22)
  if (reason.indexOf('Hostname/IP doesn\'t match certificate\'s altnames: ') === 0) reason = reason.substr(0, 48)
  state = {
    $currentDate: { timestamp: { $type: 'timestamp' } },
    $set: { verified: entry.verified, reason: reason.substr(0, 64) }
  }
  await tokens.update(indices, state, { upsert: true })

  reason = reason || (verified ? 'ok' : 'unknown')
  payload = underscore.extend(underscore.pick(entry, [ 'verificationId', 'token', 'verified' ]), { status: reason })
  await publish(debug, runtime, 'patch', entry.publisher, '/verifications', payload)
  if (!verified) return

  await runtime.queue.send(debug, 'publisher-report', { publisher: entry.publisher, verified: verified })
  reply({ status: 'success', verificationId: entry.verificationId })
}

v1.verifyToken = {
  handler: (runtime) => {
    return async (request, reply) => {
      var data, entry, entries, hint, i, info, j, matchP, pattern, reason, rr, rrset
      var publisher = request.params.publisher
      var backgroundP = request.query.backgroundP
      var debug = braveHapi.debug(module, request)
      var tokens = runtime.db.get('tokens', debug)

      entries = await tokens.find({ publisher: publisher })
      if (entries.length === 0) return reply(boom.notFound('no such publisher: ' + publisher))

      for (i = 0; i < entries.length; i++) {
        entry = entries[i]
        if (entry.verified) {
          await runtime.queue.send(debug, 'publisher-report', { publisher: entry.publisher, verified: entry.verified })
          return reply({ status: 'success', verificationId: entry.verificationId })
        }
      }

      try { rrset = await dnsTxtResolver(publisher) } catch (ex) {
        reason = ex.toString()
        if (reason.indexOf('ENODATA') === -1) {
          debug('dnsTxtResolver', underscore.extend({ publisher: publisher, reason: reason }))
        }
        rrset = []
      }
      for (i = 0; i < rrset.length; i++) { rrset[i] = rrset[i].join('') }

      var loser = async (reason) => {
        debug('verify', underscore.extend(info, { reason: reason }))
        await verified(request, reply, runtime, entry, false, backgroundP, reason)
      }

      info = { publisher: publisher }
      data = {}
      for (i = 0; i < entries.length; i++) {
        entry = entries[i]
        info.verificationId = entry.verificationId

        for (j = 0; j < rrset.length; j++) {
          rr = rrset[j]
          if (rr.indexOf(prefix2) !== 0) continue

          matchP = true
          if (rr.substring(prefix2.length) !== entry.token) {
            await loser('TXT RR suffix mismatch ' + prefix2 + entry.token)
            continue
          }

          return verified(request, reply, runtime, entry, true, backgroundP, 'TXT RR matches')
        }
        if (!matchP) {
          if (typeof matchP === 'undefined') await loser('no TXT RRs starting with ' + prefix2)
          matchP = false
        }

        for (j = 0; j < hintsK.length; j++) {
          hint = hintsK[j]
          if (typeof data[hint] === 'undefined') {
            try { data[hint] = (await webResolver(debug, runtime, publisher, hints[hint])).toString() } catch (ex) {
              data[hint] = ''
              await loser(ex.toString())
              continue
            }
            debug('verify', 'fetched data for ' + hint)
          }

          if (data[hint].indexOf(entry.token) !== -1) {
            switch (hint) {
              case root:
                pattern = '<meta[^>]*?name=["\']+' + prefix1 + '["\']+content=["\']+' + entry.token + '["\']+.*?>|' +
                        '<meta[^>]*?content=["\']+' + entry.token + '["\']+name=["\']+' + prefix1 + '["\']+.*?>'
                if (!data[hint].match(pattern)) continue
                break

              default:
                break
            }
            return verified(request, reply, runtime, entry, true, backgroundP, hint + ' web file matches')
          }
          debug('verify', 'no match for ' + hint)

          if (i === 0) break
        }
      }

      return reply({ status: 'failure' })
    }
  },

  description: 'Verifies a publisher',
  tags: [ 'api' ],

  validate: {
    params: { publisher: braveJoi.string().publisher().required().description('the publisher identity') },
    query: { backgroundP: Joi.boolean().optional().default(false).description('running in the background') }
  },

  response: {
    schema: Joi.object().keys({
      status: Joi.string().valid('success', 'failure').required().description('victory is mine!'),
      verificationId: Joi.string().guid().optional().description('identity of the verified requestor')
    })
  }
}

var publish = async (debug, runtime, method, publisher, endpoint, payload) => {
  var message, result

  try {
    result = await braveHapi.wreck[method](runtime.config.publishers.url + '/api/publishers/' + encodeURIComponent(publisher) +
                                        endpoint,
      { headers: { authorization: 'Bearer ' + runtime.config.publishers.access_token,
        'content-type': 'application/json'
      },
        payload: JSON.stringify(payload),
        useProxyP: true
      })
    if (Buffer.isBuffer(result)) try { result = JSON.parse(result) } catch (ex) { result = result.toString() }
    debug('publishers', { method: method, publisher: publisher, endpoint: endpoint, reason: result })
  } catch (ex) {
    debug('publishers', { method: method, publisher: publisher, endpoint: endpoint, reason: ex.toString() })
  }

  return message
}

var notify = async (debug, runtime, publisher, payload) => {
  var message = await publish(debug, runtime, 'post', publisher, '/notifications', payload)

  if (!message) return

  message = underscore.extend({ publisher: publisher }, payload)
  debug('notify', message)
  runtime.notify(debug, { channel: '#publishers-bot', text: 'publishers notified: ' + JSON.stringify(message) })
}

module.exports.routes = [
  braveHapi.routes.async().post().path('/v1/publishers').config(v1.bulk),
  braveHapi.routes.async().post().path('/v1/publishers/settlement/{hash}').config(v1.settlement),
  braveHapi.routes.async().path('/v1/publishers/{publisher}/balance').whitelist().config(v1.getBalance),
  braveHapi.routes.async().path('/v1/publishers/{publisher}/status').whitelist().config(v1.getStatus),
  braveHapi.routes.async().path('/v1/publishers/{publisher}/verifications/{verificationId}').whitelist().config(v1.getToken),
  braveHapi.routes.async().put().path('/v1/publishers/{publisher}/wallet').whitelist().config(v1.setWallet),
  braveHapi.routes.async().path('/v1/publishers/{publisher}/verify').config(v1.verifyToken),
  braveHapi.routes.async().patch().path('/v1/publishers/{publisher}').whitelist().config(v1.patchPublisher),
  braveHapi.routes.async().delete().path('/v1/publishers/{publisher}').whitelist().config(v1.deletePublisher)
]

module.exports.initialize = async (debug, runtime) => {
  var resolvers

  runtime.db.checkIndices(debug, [
    {
      category: runtime.db.get('publishers', debug),
      name: 'publishers',
      property: 'publisher',
      empty: {
        publisher: '',
        verified: false,
        address: '',
        legalFormURL: '',
        authorized: false,
        authority: '',
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { publisher: 1 } ],
      others: [ { verified: 1 }, { address: 1 }, { legalFormURL: 1 }, { authorized: 1 }, { authority: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.db.get('settlements', debug),
      name: 'settlements',
      property: 'settlementId_1_publisher',
      empty: { settlementId: '', publisher: '', hash: '', address: '', satoshis: 1, fees: 1, timestamp: bson.Timestamp.ZERO },
      unique: [ { settlementId: 1, publisher: 1 }, { hash: 1, publisher: 1 } ],
      others: [ { address: 1 }, { satoshis: 1 }, { fees: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.db.get('tokens', debug),
      name: 'tokens',
      property: 'verificationId_1_publisher',
      empty: { verificationId: '', publisher: '', token: '', verified: false, reason: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { verificationId: 1, publisher: 1 } ],
      others: [ { token: 1 }, { verified: 1 }, { reason: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('publisher-report')
  await runtime.queue.create('publishers-contributions-prorata')

  resolvers = underscore.uniq([ '8.8.8.8', '8.8.4.4' ].concat(dns.getServers()))
  debug('publishers', { resolvers: resolvers })
  dns.setServers(resolvers)
}
