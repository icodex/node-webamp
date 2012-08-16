// Includes and constants
var http = require('http'),
    fs = require('fs'),
    path = require('path'),
    open = require('open'),
    url = require('url'),
    util = require('util'),
    router = new require('routes').Router(),
    index_html = fs.readFileSync(
      path.join(__dirname, 'site', 'index.html')
    ),
    mount = require('st')({
      'path': path.join('site', 'static'),
      'url': 'static/'
    }),
    AmpacheSession = require('ampache'),
    conn,
    conf,
    cache_ready = false;
    cache = {};

// make the routes
router.addRoute('/', index);
router.addRoute('/api/:type?/:filter?/:new?', api);

// Export the function to create the server
module.exports = function(config) {
  conf = config;

  // Create the Ampache Object
  conn = new AmpacheSession(conf.ampache.user, conf.ampache.pass,
      conf.ampache.url, {debug: conf.ampache.debug || false});

  // Authenticate Ampache
  conn.authenticate(function(err, body) {
    if (err) {
      console.error('Failed to authenticate!');
      console.error('Username: %s', conf.ampache.user);
      console.error('URL: %s', conf.ampache.url);
      throw err;
    }
    console.log('Successfully Authenticated!');

    populate_cache();

    // Keep-Alive
    setInterval(function() {
      console.log('Keep Alive');
      conn.ping(function(err, body) {
        if (err) conn.authenticate(function (err, body) {
          if (err) throw err;
        });
      });
    }, +conf.ampache.ping || 10 * 60 * 1000);
  });

  // Create the server
  return http.createServer(on_request).listen(conf.web.port, conf.web.host, function() {
    console.log('Server running at http://%s:%d/', conf.web.host, conf.web.port);
  });
};


// Request received
function on_request(req, res) {
  // Log it
  console.log('[%s] [%s] request received from %s for %s',
      Date(), req.method, req.connection.remoteAddress, req.url);

  // static hit
  if (mount(req, res)) return;

  // Extract the URL
  var uri = url.parse(req.url),
      normalized_path = path.normalize(uri.pathname),
      route = router.match(normalized_path);

  // Route not found
  if (!route) {
    res.statusCode = 404;
    return res.end();
  }

  // Route it
  return route.fn(req, res, route.params);
}

// Index route hit
function index(req, res, params) {
  if (!cache_ready) return res.end('Cache\'s not ready');
  res.end(index_html);
}

// API Route hit
function api(req, res, params) {
  var type = params.type,
      filter = params.filter;

  if (params.new === 'new') {
    // User is requesting new information
    var func = (type === 'artists') ? AmpacheSession.prototype.get_artist
             : (type === 'albums')  ? AmpacheSession.prototype.get_album
             : (type === 'songs')   ? AmpacheSession.prototype.get_song
             : function() { res.end('[]'); };

    func.call(conn, filter, function(err, body) {
      if (err) throw err;
      res.end(JSON.stringify(body));
    });
  } else {
    // User wants it from the cache
    var data;
    if (!type) {
      data = ['artists', 'albums', 'songs'];
    } else if (!cache[type]) {
      data = [];
    } else if (filter) {
      data = cache[type][filter];
    } else {
      data = cache[type];
    }

    res.end(JSON.stringify(data));
  }
}

// Populate the caches with data
function populate_cache() {
  console.log('Populating cache');
  var to_get = {
        'artists': AmpacheSession.prototype.get_artists,
        'albums': AmpacheSession.prototype.get_albums,
        'songs': AmpacheSession.prototype.get_songs
      },
      albums_by_artist = 0,
      songs_by_album = 0;

  // Loop the caches to build
  Object.keys(to_get).forEach(function(key) {
    to_get[key].call(conn, function(err, body) {
      if (err) throw err;
      cache[key] = body;
      console.log('%s cache loaded', key);

      if ((key === 'artists' || key === 'albums')
           && ++albums_by_artist >= 2) cache_x_by_y('albums', 'artist');
      if ((key === 'albums' || key === 'songs')
           && ++songs_by_album >= 2) cache_x_by_y('songs', 'album');
      if (songs_by_album >= 2 && albums_by_artist >=2)
        caches_ready();
    });
  });
}

function cache_x_by_y(x, y) {
  console.log('Calculating %s by %s', x, y);
  var key = (x === 'albums') ? 'albums_by_artist' : 'songs_by_album';
  cache[key] = {};
  Object.keys(cache[x]).forEach(function(id) {
    var _id = +cache[x][id][y]['@'].id;
    cache[key][_id] = cache[key][_id] || [];
    cache[key][_id].push(+id);
  });
  console.log('Finished %s by %s', x, y);
}

function caches_ready() {
  cache_ready = true;
  console.log('All caches ready');
  open(util.format('http://%s:%d/', conf.web.host, conf.web.port));
}
