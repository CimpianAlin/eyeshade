module.exports =
{ port              : process.env.PORT || 3002
, database          :
  { mongo           : process.env.MONGODB_URI || 'localhost/test' }
, queue             :
  { rsmq            : process.env.REDIS_URL || 'localhost:6379' }
, wallet            :
  { bitgo           :
    { environment   : process.env.BITGO_ENVIRONMENT || '...'
    }
  }
, login             :
  { organization    : '...'
  , world           : '/documentation'
  , bye             : 'https://example.com'
  , clientId        : process.env.GITHUB_CLIENT_ID
  , clientSecret    : process.env.GITHUB_CLIENT_SECRET
  , ironKey         : process.env.IRON_KEYPASS
  , isSecure        : process.env.GITHUB_FORCE_HTTPS || false
  }
}