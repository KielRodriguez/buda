// Enable strict syntax mode
'use strict';

// Dependencies
var _ = require( 'underscore' );
var async = require( 'async' );
var helpers = require( '../../helpers' );
var mongoose = require( 'mongoose' );
var uuid = require( 'node-uuid' );
var NodeRSA = require( 'node-rsa' );

// Required models
var Consumer = mongoose.model( 'Consumer' );
var RSAKey = mongoose.model( 'RSAKey' );

// DataObject schema
// Empty/flexible schema used to interact with different data
// collections as easyly as possible
var DataObjectSchema = new mongoose.Schema({}, {
  strict:     false,
  read:       'nearest',
  versionKey: '_v',
  safe:       { j: 1, w: 'majority' }
});

// Controller definition
module.exports = function( options ) {
  // Local logger accesor
  var logger = options.logger;
  var config = options.config;

  // Helper method to format a given dataset metadata for display
  function _toDCAT( dataset ) {
    var entry = {};

    entry[ '@type' ] = 'dcat:Dataset';
    entry.title = dataset.metadata.title;
    entry.description = dataset.metadata.description;
    entry.identifier = dataset.data.storage.collection;
    entry.keyword = dataset.metadata.keyword;
    entry.issued = dataset.metadata.issued;
    entry.modified = dataset.metadata.modified;
    entry.accessLevel = dataset.metadata.accessLevel;
    entry.language = dataset.metadata.language;
    entry.license = dataset.metadata.license;
    entry.publisher = {
      '@type': 'org:Organization',
      'name':  dataset.metadata.organization
    };
    entry.contactPoint = {
      '@type':    'vcard:Contact',
      'fn':       dataset.metadata.contactName,
      'hasEmail': dataset.metadata.contactEmail
    };
    entry.distribution = [];
    entry.distribution.push({
      '@type':     'dcat:Distribution',
      'mediaType': 'application/json',
      'accessURL': '/v1/' + dataset.data.storage.collection
    });
    return entry;
  }

  // Public controller interface
  return {
    // Register a new API consumer
    // Optional params:
    //   - details: {}
    //   - accessKey: pub->base64
    registerConsumer: function( req, res, next ) {
      logger.info( 'Registering a new API cosumer' );

      // Consumer creation process
      async.waterfall( [
        // Generate the API key for the new consumer
        function newAPIKey( cb ) {
          var rsa = new NodeRSA({ b: 1024 });
          var apiKey = new RSAKey({
            fingerprint: helpers.rsaFingerprint( rsa.exportKey( 'public' ), true ),
            pub:         helpers.base64Enc( rsa.exportKey( 'public' ) ),
            priv:        helpers.base64Enc( rsa.exportKey() )
          });

          logger.debug({ apiKey: apiKey }, 'API key created' );
          apiKey.save( function( err ) {
            if( err ) {
              return cb( new Error( 'ERROR_CREATING_API_KEY' ) );
            }
            cb( null, apiKey );
          });
        },
        // Add the default access key, if any
        function addAccessKey( apiKey, cb ) {
          var userKey;
          var accessKey;
          var error = null;

          // Not present? just continue
          if( ! req.body.accessKey ) {
            return cb( null, apiKey, false );
          }

          // Validate and store provided key
          logger.debug( 'Registering default access key' );
          userKey = new NodeRSA();
          try {
            // Validate key
            userKey.importKey( helpers.base64Dec( req.body.accessKey ) );
            if( ! userKey.isPublic() ) {
              error = new Error( 'INVALID_PUBLIC_KEY' );
              error.status = 400;
              throw error;
            }

            // Store key
            accessKey = new RSAKey({
              fingerprint: helpers.rsaFingerprint( userKey.exportKey( 'public' ), true ),
              pub:         helpers.base64Enc( userKey.exportKey( 'public' ) )
            });

            logger.debug({ accessKey: accessKey }, 'Adding default access key' );
            accessKey.save( function( err ) {
              if( err ) {
                throw new Error( 'ERROR_STORING_ACCESS_KEY' );
              }
              cb( null, apiKey, accessKey._id );
            });
          } catch( e ) {
            // Continue
            logger.fatal({ key: req.body.accessKey, error: e }, 'Invalid key provided' );
            return cb( null, apiKey, false );
          }
        },
        // Store the new consumer record
        function saveConsumer( apiKey, accessKey, cb ) {
          var consumer = new Consumer({
            uuid:    uuid.v4().toUpperCase(),
            apiKey:  apiKey._id,
            details: req.body.details || {}
          });

          // Add the default accesskey if present
          if( accessKey ) {
            consumer.accessKeys.push( accessKey );
          }

          consumer.save( function( err ) {
            if( err ) {
              return cb( err );
            }
            logger.debug( 'New consumer registered' );
            consumer
              .populate( 'accessKeys', 'fingerprint pub' )
              .populate( 'apiKey', 'fingerprint pub' )
              .populate( function( error, doc ) {
                if( error ) {
                  return cb( error );
                }
                return cb( null, doc );
              });
          });
        }
      ], function( err, result ) {
        if( err ) {
          logger.fatal({ error: err }, 'Consumer registration error' );
          return next( err );
        }
        logger.debug({ result: result }, 'Consumer registration complete' );
        res.json( result );
      });
    },

    // Retrieve's a specific consumer details
    getConsumerInfo: function( req, res, next ) {
      var error;

      // Run query with the provided ID
      logger.info( 'Getting consumer details' );
      Consumer.findById( req.params.id, function( err, consumer ) {
        if( err ) {
          return next( err );
        }

        if( ! consumer ) {
          error = new Error( 'INVALID_CONSUMER_ID' );
          error.status = 400;
          return next( error );
        }

        // Populate apikey information
        consumer
          .populate( 'accessKeys', 'fingerprint -_id' )
          .populate( 'apiKey', 'fingerprint pub' )
          .populate( function( err2, doc ) {
            if( err2 ) {
              return next( err2 );
            }
            res.json( doc );
          });
      });
    },

    // Adds a new access key for a given consumer
    // Required parameters:
    //   - accessKey: pub->base64
    addConsumerKey: function( req, res, next ) {
      var error;
      var newKey;
      var accessKey;

      // Validate required parameters are present
      logger.info( 'Add consumer key' );
      if( ! req.body.accessKey ) {
        error = new Error( 'MISSING_PARAMETERS' );
        error.status = 400;
        return next( error );
      }

      // Retrieve consumer
      Consumer.findById( req.params.id, function( err, consumer ) {
        if( err ) {
          return next( err );
        }

        // Invalid ID check
        if( ! consumer ) {
          error = new Error( 'INVALID_CONSUMER_ID' );
          error.status = 400;
          return next( error );
        }

        // Validate provided key
        newKey = new NodeRSA();
        try {
          // Validate key
          newKey.importKey( helpers.base64Dec( req.body.accessKey ) );
          if( ! newKey.isPublic() ) {
            error = new Error( 'INVALID_PUBLIC_KEY' );
            error.status = 400;
            throw error;
          }
        } catch( e ) {
          return next( e );
        }

        // Store key
        accessKey = new RSAKey({
          fingerprint: helpers.rsaFingerprint( newKey.exportKey( 'public' ), true ),
          pub:         helpers.base64Enc( newKey.exportKey( 'public' ) )
        });

        logger.debug({ accessKey: accessKey }, 'Adding new access key' );
        accessKey.save( function( err2 ) {
          if( err2 ) {
            return next( err2 );
          }

          // Update consumer record
          consumer.accessKeys.push( accessKey._id );
          consumer.save( function( err3 ) {
            if( err3 ) {
              return next( err3 );
            }

            res.json( accessKey );
            // return;
          });
        });
      });
    },

    // Delete a given access key for a specific consumer
    delConsumerKey: function( req, res, next ) {
      var error;

      logger.info( 'Delete consumer key' );
      async.waterfall( [
        // Validate the provided consumer ID
        function validateConsumer( cb ) {
          Consumer.findById( req.params.id, function( err, consumer ) {
            if( err ) {
              return cb( err );
            }

            if( ! consumer ) {
              error = new Error( 'INVALID_CONSUMER_ID' );
              error.status = 400;
              return cb( error );
            }

            cb( null, consumer );
          });
        },
        // Validate the provided key id
        function validateKeyID( consumer, cb ) {
          if( consumer.accessKeys.indexOf( req.params.keyId ) < 0 ) {
            error = new Error( 'INVALID_KEY_ID' );
            error.status = 400;
            return cb( error );
          }

          RSAKey.remove({ _id: req.params.keyId }, function( err, key ) {
            if( err ) {
              return cb( new Error( 'ERROR_REMOVING_KEY' ) );
            }

            consumer.accessKeys.splice( consumer.accessKeys.indexOf( key._id ), 1 );
            consumer.save( function( err2 ) {
              if( err2 ) {
                return cb( new Error( 'ERROR_UPDATING_CONSUMER_RECORD' ) );
              }

              cb( null, consumer );
            });
          });
        }
      ], function( err, result ) {
        if( err ) {
          logger.fatal({ error: err }, 'Access key removal error' );
          return next( err );
        }
        logger.debug({ result: result }, 'Access key removal complete' );
        res.json( result );
      });
    },

    // Retrieve metadata of the existing catalog
    catalogInfo: function( req, res, next ) {
      var DataObject = mongoose.model( 'DataObject', DataObjectSchema, 'sys.datasets' );
      var queryString = req.query;
      var page = queryString.page || 1;
      var pageSize = queryString.pageSize || 100;
      var query = DataObject.find({}, { _id: 0 });

      // Metadata holder structure
      var metadata = {
        '@type':       'dcat:Catalog',
        'title':       config.title,
        'description': config.desc,
        'dataset':     []
      };

      // Count results
      logger.info( 'Retrieve catalog metadata' );
      DataObject.find().count( function( err, total ) {
        if( err ) {
          return next( err );
        }

        // Paginate query
        query
          .skip( ( page - 1 ) * pageSize )
          .limit( pageSize );

        // Run query
        query.exec( function( err2, docs ) {
          if( err2 ) {
            return next( err2 );
          }

          // Format results
          _.each( docs, function( dataset ) {
            metadata.dataset.push( _toDCAT( dataset._doc ) );
          });

          // Return
          res.json({
            metadata:   metadata,
            pagination: {
              page:     page,
              pageSize: pageSize,
              total:    total
            }
          });
        });
      });
    },

    // Run a general data query
    /* eslint max-len:0 */
    runQuery: function( req, res, next ) {
      // ISO 8601 regex
      // Originally from: http://goo.gl/qKfN2e
      var isoDateRE = /^([\+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-2])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24\:?00)([\.,]\d+(?!:))?)?(\17[0-5]\d([\.,]\d+)?)?([zZ]|([\+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$/;
      var operatorRE = /\[(\w*):(.*)\]/;
      var collection = req.params.dataCollection;
      var opSegments;
      var DataObject;
      var query;
      var queryString;
      var queryRange;
      var page;
      var pageSize;
      var error;

      // Validate collection
      if( collection.substr( 0, 4 ) === 'sys.' ||
          collection.substr( 0, 7 ) === 'system.' ) {
        logger.info( 'Restricted query' );
        logger.debug({ collection: collection }, 'Restricted query' );
        error = new Error( 'RESTRICTED_DATA_COLLECTION' );
        error.status = 400;
        return next( error );
      }

      // Adjust model to run-time requirements
      DataObject = mongoose.model( 'DataObject', DataObjectSchema, collection );

      // Pagination variables
      queryString = req.query;
      page = parseInt( queryString.page, 10 ) || 1;
      pageSize = parseInt( queryString.pageSize, 10 ) || 100;
      delete queryString.page;
      delete queryString.pageSize;

      // Process operators in query string
      /* eslint complexity:0 */
      _.each( queryString, function( v, k ) {
        // Test if the value provided is an operator
        if( operatorRE.test( v ) ) {
          // Get operator key and value
          opSegments = v.split( operatorRE );

          // Loog for supported operator keys
          switch( opSegments[ 1 ] ) {
            // Greater than
            case 'gt':
              // Verify if provided value is a valid date
              if( opSegments[ 2 ].match( isoDateRE ) ) {
                console.log( 'is a date' );
                opSegments[ 2 ] = new Date( opSegments[ 2 ] );
              }

              queryString[ k ] = { $gt: opSegments[ 2 ] };
              break;
            // Greater than or equal
            case 'gte':
              // Verify if provided value is a valid date
              if( opSegments[ 2 ].match( isoDateRE ) ) {
                opSegments[ 2 ] = new Date( opSegments[ 2 ] );
              }

              queryString[ k ] = { $gte: opSegments[ 2 ] };
              break;
            // Lesser than
            case 'lt':
              // Verify if provided value is a valid date
              if( opSegments[ 2 ].match( isoDateRE ) ) {
                opSegments[ 2 ] = new Date( opSegments[ 2 ] );
              }

              queryString[ k ] = { $lt: opSegments[ 2 ] };
              break;
            // Lesser than or equal
            case 'lte':
              // Verify if provided value is a valid date
              if( opSegments[ 2 ].match( isoDateRE ) ) {
                opSegments[ 2 ] = new Date( opSegments[ 2 ] );
              }

              queryString[ k ] = { $lte: opSegments[ 2 ] };
              break;
            // In set
            case 'in':
              queryString[ k ] = { $in: opSegments[ 2 ].split( ',' ) };
              break;
            // Not-in set
            case 'nin':
              queryString[ k ] = { $nin: opSegments[ 2 ].split( ',' ) };
              break;
            // In range
            case 'range':
              // Get range values
              queryRange = opSegments[ 2 ].split( '|' );

              // Verify if provided values are valid dates
              if( queryRange[ 0 ].match( isoDateRE ) ) {
                queryRange[ 0 ] = new Date( queryRange[ 0 ] );
              }
              if( queryRange[ 1 ].match( isoDateRE ) ) {
                queryRange[ 1 ] = new Date( queryRange[ 1 ] );
              }

              queryString[ k ] = {
                $gte: queryRange[ 0 ],
                $lte: queryRange[ 1 ]
              };
              break;
            // Regex operator; text is an alias
            case 'text':
            case 'regex':
              queryString[ k ] = new RegExp( opSegments[ 2 ], 'ig' );
              break;
            // Delete unsupported operators
            default:
              delete queryString[ k ];
          }
        }
      });

      // Run query
      logger.info( 'Run query' );
      logger.debug({ queryString: queryString }, 'Run query with filters' );
      query = DataObject.find( queryString );
      DataObject.find( queryString ).count( function( err, total ) {
        if( err ) {
          return next( err );
        }

        query
          .skip( ( page - 1 ) * pageSize )
          .limit( pageSize );

        // Run query
        query.exec( function( err2, docs ) {
          if( err2 ) {
            return next( err2 );
          }

          res.json({
            results:    docs,
            pagination: {
              page:     page,
              pageSize: pageSize,
              total:    total
            }
          });
        });
      });
    },

    // Retrieve a specific data document
    getDocument: function( req, res, next ) {
      var collection;
      var error;
      var DataObject;

      // Validate collection
      logger.info( 'Retrieve document' );
      collection = req.params.dataCollection;
      if( collection.substr( 0, 4 ) === 'sys.' ||
          collection.substr( 0, 7 ) === 'system.' ) {
        error = new Error( 'RESTRICTED_DATA_COLLECTION' );
        error.status = 400;
        return next( error );
      }

      // Adjust model to run-time requirements
      DataObject = mongoose.model( 'DataObject', DataObjectSchema, collection );

      // Try to retrieve the requested document
      DataObject.findById( req.params.docId, function( err, doc ) {
        if( err ) {
          return next( err );
        }

        if( ! doc ) {
          error = new Error( 'INVALID_DOCUMENT_ID' );
          error.status = 400;
          return next( error );
        }

        res.json( doc );
      });
    },

    // Register a new data record/document
    registerDocument: function( req, res, next ) {
      var collection;
      var error;
      var DataObject;
      var doc;

      // Validate collection
      logger.info( 'Register document' );
      collection = req.params.dataCollection;
      if( collection.substr( 0, 4 ) === 'sys.' ||
          collection.substr( 0, 7 ) === 'system.' ) {
        error = new Error( 'RESTRICTED_DATA_COLLECTION' );
        error.status = 400;
        return next( error );
      }

      // Validate there's data to work with
      if( _.isEmpty( req.body ) ) {
        error = new Error( 'NO_DATA_PROVIDED' );
        error.status = 400;
        return next( error );
      }

      // Adjust model to run-time requirements
      DataObject = mongoose.model( 'DataObject', DataObjectSchema, collection );

      // Create and store document
      doc = new DataObject( req.body );
      doc.save( function( err ) {
        if( err ) {
          return next( err );
        }

        res.json( doc );
      });
    },

    // Update a specific data document
    updateDocument: function( req, res, next ) {
      var collection;
      var error;
      var DataObject;
      var docId = req.params.docId;

      // Validate collection
      logger.info( 'Update document' );
      collection = req.params.dataCollection;
      if( collection.substr( 0, 4 ) === 'sys.' ||
          collection.substr( 0, 7 ) === 'system.' ) {
        error = new Error( 'RESTRICTED_DATA_COLLECTION' );
        error.status = 400;
        return next( error );
      }

      // Validate there's data to work with
      if( _.isEmpty( req.body ) ) {
        error = new Error( 'NO_DATA_PROVIDED' );
        error.status = 400;
        return next( error );
      }

      // Adjust model to run-time requirements
      DataObject = mongoose.model( 'DataObject', DataObjectSchema, collection );

      // Try to retrieve and update the requested document
      /* eslint no-reserved-keys:0 */
      DataObject.findByIdAndUpdate( docId, req.body, { new: true }, function( err, doc ) {
        if( err ) {
          return next( err );
        }

        if( ! doc ) {
          error = new Error( 'INVALID_DOCUMENT_ID' );
          error.status = 400;
          return next( error );
        }

        res.json( doc );
      });
    },

    // Delete a specific data document
    delDocument: function( req, res, next ) {
      var collection;
      var error;
      var DataObject;
      var docId = req.params.docId;

      // Validate collection
      logger.info( 'Delete document' );
      collection = req.params.dataCollection;
      if( collection.substr( 0, 4 ) === 'sys.' ||
          collection.substr( 0, 7 ) === 'system.' ) {
        error = new Error( 'RESTRICTED_DATA_COLLECTION' );
        error.status = 400;
        return next( error );
      }

      // Adjust model to run-time requirements
      DataObject = mongoose.model( 'DataObject', DataObjectSchema, collection );

      // Try to select and remove the requested document
      DataObject.findByIdAndRemove( docId, function( err, doc ) {
        if( err ) {
          return next( err );
        }

        if( ! doc ) {
          error = new Error( 'INVALID_DOCUMENT_ID' );
          error.status = 400;
          return next( err );
        }

        res.json( doc );
      });
    }
  };
};
