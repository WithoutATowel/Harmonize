var express = require('express');
var db = require('../models');
var passport = require('../config/passport-config');
var request = require('request');
var async = require('async');
var isLoggedIn = require('../middleware/is-logged-in');
var router = express.Router();

// Helper function to save songs returned by the Spotify API to the database and associate with a user. 
function storeTracks(array, user) {
    return new Promise(function(resolve, reject) {  
        async.each(array, function(track, callback){
            // Generalize function to handle return values from different spotify calls
            if (!track.artists) {
                track = track.track;
            }
            // Make sure the song has a Spotify ID. If not, go on to the next.
            if (track.id) {
                // If not already present, store each artist in the database
                db.artist.findOrCreate({
                    where: { spotifyId: track.artists[0].id},
                    defaults: {
                        name: track.artists[0].name,
                        popularity: 0 
                    }
                }).spread(function(artist, created) {
                    // If not already present, store each song in the database
                    db.song.findOrCreate({
                        where: { spotifyId: track.id},
                        defaults: {
                            artistId: artist.id,
                            name: track.name,
                            popularity: track.popularity,
                            previewUrl: track.preview_url
                        }
                    }).spread(function(song, created) {
                        // Associate the song with the user
                        db.users_songs.findOrCreate({
                            where: { userId: user.id, songId: song.id}
                        }).then(function() {
                            callback();
                        });
                    });
                });
            } else {
                callback();
            }
        }, function() {
            resolve('Stuff worked!');
        });
    });
}

// GET /profile 
router.get('/', isLoggedIn, function(req, res) {
    res.render('profile/index', { user: req.user });
});

// GET /download
router.get('/download', isLoggedIn, function(req,res) {
    res.render('profile/loading');
    var user = req.user;
    var options = {
        url: 'https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=long_term',
        headers: {
            'Authorization': 'Bearer ' + user.accessToken
        }
    };
    async.parallel(
        [
            function(callback) {
                // Get and store favorite songs from the past several years
                request(options, function(error,response,body) {
                    var topTracks = JSON.parse(body);
                    storeTracks(topTracks.items, user).then(function(){
                        callback();
                    });
                });
            }, function(callback) {
                // Get and store favorite songs from the past 6 months
                options.url = 'https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term';
                request(options, function(error,response,body) {
                    var topTracks = JSON.parse(body);
                    storeTracks(topTracks.items, user).then(function(){
                        callback();
                    });   
                });  
            }, function(callback) {
                // Get and store favorite songs from the past 4 weeks
                options.url = 'https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term';
                request(options, function(error,response,body) {
                    var topTracks = JSON.parse(body);
                    storeTracks(topTracks.items, user).then(function(){
                        callback();
                    });   
                });
            }, function(callback) {
                // Get ALL saved songs. Max 50 per request, so loop through songs using async.
                options.url = 'https://api.spotify.com/v1/me/tracks?limit=50';
                var moreToDownload = true;
                async.whilst(function() {
                        return moreToDownload;
                    }, function(cb) {
                        request(options, function(error,response,body) {
                            var topTracks = JSON.parse(body);
                            storeTracks(topTracks.items, user, true).then(function() {
                                moreToDownload = (topTracks.next === null) ? false : true; 
                                options.url = moreToDownload ? topTracks.next : null;
                                cb();
                            });   
                        });
                    }, function(err, n) {
                        callback();
                    }
                );
            }, function(callback) {
                // Get URLs for all of a user's playlists. Max 50 per request and user may have more, 
                // so we're going to need a loop. And a bigger boat.
                // This loop needs to be synchronous (not go to the next iteration until the first one is finished) because we get
                // the URL for the next call from the first.
                options.url = 'https://api.spotify.com/v1/me/playlists';
                var moreToDownload = true;
                var playlistUris = [];
                async.whilst(function() {
                        return moreToDownload;
                    }, function(cb) {
                        request(options, function(error,response,body) {
                            var results = JSON.parse(body);
                            playlistUris = playlistUris.concat(results.items.map((aPlaylist) => aPlaylist.tracks.href));
                            moreToDownload = (results.next === null) ? false : true; 
                            options.url = moreToDownload ? results.next : null;
                            cb(); // Next iteration of the "get playlists" whilst loop  
                        });
                    }, function(err, n) {
                        // Now we need to download and store songs from each playlist. So, we're going to start by 
                        // looping through the playlistUri array. This loop can be asynchronous since downloading the songs for a given
                        // playlist is independent of downloading another's. But we need to wait on the callback for async.parallel
                        // until ALL playlists have been downloaded, so async.each() is needed vs. a normal Array.forEach().
                        async.each(playlistUris, 
                            function(playlistUri, cb) {
                                options.url = playlistUri;
                                // Each playlist can have more than 50 songs, so we need a third nested loop to handle multiple requests 
                                // per playlist. This loop needs to be be synchronous because we get the URI for the next call from 
                                // the previous one.
                                var moreToDownload = true;
                                async.whilst(function() {
                                        return moreToDownload;
                                    }, function(callB) {
                                        request(options, function(error,response,body) {
                                            var trackList = JSON.parse(body);
                                            storeTracks(trackList.items, user, true).then(function() {
                                                moreToDownload = (trackList.next === null) ? false : true; 
                                                options.url = moreToDownload ? trackList.next : null;
                                                callB(); // download the next batch of songs
                                            });
                                        });
                                    }, function() {
                                        cb(); // let async.each know that we're done downloading songs for this playlist
                                    }
                                );
                            }, function(err, n) {
                                callback(); // finishes parallel item when all playlists have been downloaded
                            }
                        );
                    }
                );
            }
        ], function(err, results) {
            db.user.update({
                songDataDownloaded: true
            }, {
                where: { id: user.id }
            });
        }
    );
});

// GET /profile/ready is a route that client-side JavaScript can ping from the "loading" page to check
// whether or not to redirect to the welcome page.
router.get('/ready', isLoggedIn, function(req, res) {
    db.user.findByPk(req.user.id).then(function(user) {
        // Check whether song data has been fully downloaded for the user, and let the client-side AJAX know
        if (user.songDataDownloaded) {
            res.send('Download complete');
        } else {
            res.send('Naw dawg');
        }
    });
});

// GET /profile/welcome shows a one time welcome screen that explains "Public names" to the user
router.get('/welcome', isLoggedIn, function(req, res) {
    res.render('profile/welcome', { user: req.user });
});

// PUT /profile allows users to update their public names
router.put('/', isLoggedIn, function(req, res) {
    db.user.update({
        displayName: req.body.publicName
    }, {
        where: { id: req.user.id }
    }).then(function(data) {
        db.user.findByPk(req.user.id).then(function(user) {
            req.login(user, function(err) {
                if (err) {
                    console.log(err);
                }
            });
            req.flash('success', 'Public name updated');
            res.send('success');
        });
    });
});

// DELETE /profile
router.delete('/', isLoggedIn, function(req, res) {
    var userId = req.user.id;
    // Use async.series to delete all references to the user throughout the database, including playlists
    // created by the user.
    async.series([
        function(callback) {
            // Delete records from playlists_songs for owned playlists
            var query = 'DELETE FROM playlists_songs ' +
                        'WHERE "playlistId" in (' + 
                          'SELECT "playlistId" ' + 
                          'FROM users_playlists ' + 
                          'WHERE "userId" = ' + userId + ');';
            db.sequelize.query(query).then(function(results) {
                callback();
            });
        }, function(callback) {
            // Delete the playlists themselves
            var query = 'DELETE FROM playlists ' +
                        'WHERE id in (' + 
                          'SELECT "playlistId" ' + 
                          'FROM users_playlists ' + 
                          'WHERE "userId" = ' + userId + ');';
            db.sequelize.query(query).then(function(results) {
                callback();
            });
        }, function(callback) {
            // Delete records from users_playlists
            var query = 'DELETE FROM users_playlists ' + 
                        'WHERE "userId" = ' + userId + ';';
            db.sequelize.query(query).then(function(results) {
                callback();
            });
        }, function(callback) {
            // Delete records from users_songs
            var query = 'DELETE FROM users_songs ' + 
                        'WHERE "userId" = ' + userId + ';';
            db.sequelize.query(query).then(function(results) {
                callback();
            });
        }, function(callback) {
            // Delete user
            var query = 'DELETE FROM users ' + 
                        'WHERE id = ' + userId + ';';
            db.sequelize.query(query).then(function(results) {
                callback();
            });
        }], function(err, results) {
            res.send('Profile deleted.');
        }
    );
});

module.exports = router;