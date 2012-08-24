// Includes and constants
var http = require('http'),
    fs = require('fs'),
    path = require('path'),
    open = require('open'),
    url = require('url'),
    util = require('util'),
    request = require('request'),
    async = require('async'),
    router = new require('routes').Router(),
    theme_url = path.join('/static/third-party/bootswatch'),
    theme_names = fs.readdirSync(
      path.join(__dirname, 'site', theme_url)
    ),
    index_html = fs.readFileSync(
      path.join(__dirname, 'site', 'index.html')
    ),
    AmpacheSession = require('ampache'),
    conn,
    conf,
    cache_ready = false,
    cache_dir = 'cache',
    cache = {};

// make the routes
router.addRoute('/', index);
router.addRoute('/cache/*', cache_hit);
router.addRoute('/static/*', static_hit);
router.addRoute('/api/:type?/:filter?/:new?', api);

// Export the function to create the server
module.exports = function(config) {
  conf = config;
  cache_dir = path.join(conf.webamp_dir, cache_dir);

  require('log-timestamp');

  // Create the Ampache Object
  conn = new AmpacheSession(conf.ampache.user, conf.ampache.pass,
      conf.ampache.url, {debug: conf.ampache.debug || false});

  // Authenticate to Ampache
  conn.authenticate(function(err, body) {
    if (err) {
      console.error('Failed to authenticate!');
      console.error('Username: %s', conf.ampache.user);
      console.error('URL: %s', conf.ampache.url);
      throw err;
    }
    console.log('Successfully Authenticated!');

    populate_cache(body);

    // Keep-Alive
    setInterval(function() {
      console.log('Sending Keep Alive');
      conn.ping(function(err, body) {
        if (body.session_expire) console.log('Sessions expires: %s', body.session_expire);
        if (err || !body.session_expire) conn.authenticate(function(err, body) {
          if (err) throw err;
          console.log('Session Expired: Reauthentication successful');
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
  weblog('[%s] request received from %s for %s',
      req.method, req.connection.remoteAddress, req.url);

  // Extract the URL
  route = router.match(normalize_url(req.url));

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
      if (body && body.error) {
        // Try once to reauth
        console.warn(body.error);
        console.warn('Session expired - reauthenticating');
        conn.authenticate(function(err, body) {
          if (err) throw err;
          func.call(conn, filter, function(err, body) {
            if (err) throw err;
            res.end(JSON.stringify(body));
          });
        });
      } else {
        res.end(JSON.stringify(body));
      }
    });
  } else {
    // User wants it from the cache
    var data;
    if (!type) {
      data = Object.keys(cache);
    } else if (!cache[type]) {
      data = [];
      if (type === 'themes') {
        data = {};
        theme_names.forEach(function(theme) {
          data[theme] = path.join(theme_url, theme, 'bootstrap.min.css');
        });
      } else if (type === 'conf') {
        data = {
          'cache': conf.cache
        };
      }
    } else if (filter) {
      data = cache[type][filter];
    } else {
      data = cache[type];
    }

    res.end(JSON.stringify(data));
  }
}

/**
 * static assets
 */
function cache_hit(req, res, params) {
  var normalized_url = normalize_url(req.url).replace('/cache', '/media'),
      filename = path.join(cache_dir, normalized_url);
  _serve_file(filename, res);
}
function static_hit(req, res, params) {
  var normalized_url = normalize_url(req.url);
      filename = path.join(__dirname, 'site', normalized_url);
  _serve_file(filename, res);
}
function _serve_file(f, res) {
  fs.stat(f, function(err, stats) {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    fs.createReadStream(f).pipe(res);
  });
}

// Populate the caches with data
function populate_cache(body) {
  console.log('Populating cache');
  var funcs = {
        'artists': AmpacheSession.prototype.get_artists,
        'albums': AmpacheSession.prototype.get_albums,
        'songs': AmpacheSession.prototype.get_songs
      },
      to_get = {},
      albums_by_artist = 0,
      songs_by_album = 0;

  if (cache_up_to_date(body)) {
    ['artists', 'albums', 'songs'].forEach(function(key) {
      try {
        cache[key] = require(path.join(cache_dir, key + '.json'));
        console.log('Loaded %s from local cache', key);
        try_to_process(key);
      } catch (e) {
        console.error('Failed to load %s from local cache', key);
        to_get[key] = funcs[key];
      }
    });
  } else {
    to_get = funcs;
  }

  // Loop the caches to build from remote source
  Object.keys(to_get).forEach(function(key) {
    to_get[key].call(conn, function(err, body) {
      if (err) throw err;
      cache[key] = body;
      // Save the cache
      fs.writeFile(path.join(cache_dir, key + '.json'), JSON.stringify(body), function(err) {
        if (err) return console.error(err);
      });
      console.log('Loaded %s from remote source', key);

      try_to_process(key);
    });
  });

  function try_to_process(key) {
    if (key === 'albums' && conf.cache.artwork) cache_album_art();
    if ((key === 'artists' || key === 'albums')
         && ++albums_by_artist >= 2) cache_x_by_y('albums', 'artist');
    if ((key === 'albums' || key === 'songs')
         && ++songs_by_album >= 2) cache_x_by_y('songs', 'album');
    if (songs_by_album >= 2 && albums_by_artist >=2)
      caches_ready(body);
  }
}

// Grab all of the album art to cache locally
function cache_album_art() {
  var art_dir = path.join(cache_dir, 'media', 'art'),
      queue = async.queue(q, 200);

  Object.keys(cache.albums).forEach(function(album) {
    var filename = path.join(art_dir, album) + '.jpg';
    fs.exists(filename, function(e) {
      if (!e) {
        queue.push({'url': cache.albums[album].art, 'file': filename},
          function() {});
      }
    });
  });

  function q(task, cb) {
    var r = request(task.url),
        s = fs.createWriteStream(task.file);
    r.pipe(s, {'end': false});
    r.on('end', function() {
      s.end();
      cb();
    });
  }
}

// Cache 'songs' by 'album', or something
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

// Fired when the caches are ready
function caches_ready(body) {
  cache_ready = true;
  console.log('All caches ready');

  // Save the auth data for the update/add/clean times
  fs.writeFile(path.join(cache_dir, 'update.json'), JSON.stringify(body), function(err) {
    if (err) return console.error(err);
  });

  open(util.format('http://%s:%d/', conf.web.host, conf.web.port));
}

// Check if the cache is up to date
function cache_up_to_date(body) {
  var ok = true;

  try {
    var old_body = require(path.join(cache_dir, 'update.json'));
  } catch (e) {
    return false;
  }

  ['add', 'update', 'clean'].forEach(function(key) {
    if (body[key].toJSON() !== old_body[key]) {
      console.log('Cache not up-to-date - pulling from remote source (%s)', key);
      ok = false;
    }
  });

  return ok;
}

function weblog() {
  if (conf.web.log) console.log.apply(this, arguments);
}

function normalize_url(uri) {
  var uri = url.parse(uri),
      normalized_path = path.normalize(uri.pathname);
  return normalized_path;
}
