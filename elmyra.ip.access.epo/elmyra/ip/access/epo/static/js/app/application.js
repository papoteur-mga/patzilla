// -*- coding: utf-8 -*-
// (c) 2013-2015 Andreas Motl, Elmyra UG

/**
 * ------------------------------------------
 *          main application object
 * ------------------------------------------
 */
OpsChooserApp = Backbone.Marionette.Application.extend({

    setup_ui: function() {

        // Initialize content which still resides on page level (i.e. no template yet)
        $('#query').val(this.config.get('query'));

    },

    get_datasource: function() {
        var datasource = $('#datasource > .btn.active').data('value');
        return datasource;
    },

    set_datasource: function(datasource) {
        $("#datasource .btn[data-value='" + datasource + "']").button('toggle');
        this.queryBuilderView.setup_cql_field_chooser();
        this.queryBuilderView.setup_common_form();
        this.queryBuilderView.setup_comfort_form();
    },

    get_query: function() {
        return $('#query').val();
    },

    disable_reviewmode: function() {
        this.metadata.set('reviewmode', false);
    },

    populate_metadata: function() {
        var query_data = this.queryBuilderView.get_common_form_data();
        this.metadata.set('query_data', query_data);
    },


    // TODO: move to search.js

    // Perform OPS search and process response
    perform_search: function(options) {

        options = options || {};

        // propagate datasource
        // TODO: Fix me?
        //options.datasource = datasource;


        // 1. initialize search
        var query = this.get_query();
        var datasource = this.get_datasource();
        this.metadata.set('datasource', datasource);

        // it's probably important to reset e.g. "result_range",
        // because we have to fetch 1-10 for each single result page from OPS
        this.metadata.resetSomeDefaults(options);


        // 2. handle review mode
        if (options && options.reviewmode != null) {
            this.metadata.set('reviewmode', options.reviewmode);
        }
        // TODO: maybe move to pagination.js
        var reviewmode = this.metadata.get('reviewmode');
        if (reviewmode == true) {
            this.basketModel.review(options);
            return;
        }


        // 3. perform search

        if (_.isEmpty(query)) {
            return;
        }

        console.log('App.perform_search: datasource=' + datasource, 'query=' + query, 'options=', options);

        // propagate keywords from comfort form for fallback mechanism
        options.keywords = $('#keywords').val();

        // propagate bunches of options around
        // a) to metadata object
        // b) to search_info summary object
        // TODO: consolidate somehow
        var search_info = {datasource: datasource, query: query};
        if (options.flavor) {
            this.metadata.set('flavor', options.flavor);
            search_info.flavor = options.flavor;
        }
        if (options.query_data) {
            this.metadata.set('query_data', options.query_data);
        }
        search_info.query_data = this.metadata.get('query_data');

        var self = this;
        var _this = this;

        // OPS is the main data source for bibliographic data.
        // It is used for all things display.
        if (datasource == 'ops') {
            var range = this.compute_range(options);
            search_info.range = range;
            this.trigger('search:before', search_info);

            var engine = opsChooserApp.search;
            engine.perform(this.documents, this.metadata, query, range).then(function() {

                _this.trigger('search:success', search_info);

                var hits = self.metadata.get('result_count');
                if (hits == 0) {
                    _this.ui.no_results_alert(search_info);

                } else if (hits > self.metadata.get('maximum_results')['ops']) {
                    _this.ui.user_alert('Total hits: ' + hits + '.    ' +
                        'The first 2000 hits are accessible from OPS.  ' +
                        'You can narrow your search by adding more search criteria.', 'warning');
                }

                // propagate keywords
                log('engine.keywords:', engine.keywords);
                _this.metadata.set('keywords', engine.keywords);

                // signal the results are ready
                _this.trigger('results:ready');

                // Record the current search query
                search_info.result_count = hits;
                _this.trigger('query:record', search_info);

            }).fail(function(xhr) {

                _this.trigger('search:failure', search_info);

                if (xhr.status == 404) {

                    // Propagate zero result count
                    _this.metadata.set('result_count', 0);

                    // Display "No results" notification
                    _this.ui.no_results_alert(search_info);

                }

                // signal the results are ready
                _this.trigger('results:ready');

            });

        // Auxilliary data sources are used for searching
        } else if (datasource == 'depatisnet') {
            var engine = new DepatisnetSearch();
            search_info.engine = engine;
            return this.generic_search(search_info, options);

        } else if (datasource == 'ftpro') {
            var engine = new FulltextProSearch();
            search_info.engine = engine;
            return this.generic_search(search_info, options);

        } else if (datasource == 'ifi') {
            var engine = new IFIClaimsSearch();
            search_info.engine = engine;
            return this.generic_search(search_info, options);

        } else if (datasource == 'google') {

            this.trigger('search:before', search_info);

            // make the pager display the original query
            this.metadata.set('query_origin', query);

            var engine = new GooglePatentSearch();
            engine.perform(query, options).done(function(response) {
                options = options || {};

                _this.trigger('search:success', search_info);

                _this.propagate_datasource_message(response);

                // propagate keywords
                log('engine.keywords:', engine.keywords);
                _this.metadata.set('keywords', engine.keywords);

                // debugging
                console.log('google response:', response);
                console.log('google keywords:', engine.keywords);

                var publication_numbers = response['numbers'];
                var hits = response['hits'];

                if (publication_numbers) {

                    // TODO: return pagesize from backend
                    options.remote_limit = 100;

                    self.perform_listsearch(options, query, publication_numbers, hits, 'pn', 'OR').done(function() {

                        // propagate upstream message again, because "perform_listsearch" clears it; TODO: enhance mechanics!
                        _this.propagate_datasource_message(response);

                        if (hits == null) {
                            _this.ui.user_alert(
                                'Result count unknown. At Google Patents, sometimes result counts are not displayed. ' +
                                "Let's assume 1000 to make the paging work.", 'warning');
                        }

                        if (hits > _this.metadata.get('maximum_results')['google']) {
                            _this.ui.user_alert(
                                'Total results ' + hits + '. From Google Patents, the first 1000 results are accessible. ' +
                                'You might want to narrow your search by adding more search criteria.', 'warning');
                        }
                    });
                }

            });

        } else {
            this.ui.notify('Search provider "' + datasource + '" not implemented.', {type: 'error', icon: 'icon-search'});
        }

    },

    generic_search: function(search_info, options) {

        this.trigger('search:before', search_info);

        var engine = search_info.engine;
        var query = search_info.query;

        // make the pager display the original query
        this.metadata.set('query_origin', query);

        var _this = this;
        return engine.perform(query, options).then(function(response) {
            options = options || {};

            // Signal search success
            _this.trigger('search:success', search_info);

            log('upstream response:', response);
            log('engine.keywords:', engine.keywords);

            // Propagate information from backend to user interface
            // Message and Keywords
            _this.propagate_datasource_message(response);
            _this.metadata.set('keywords', engine.keywords);

            // Propagate page control parameters to listsearch
            var hits = response.meta.navigator.count_total;
            options['remote_limit'] = response.meta.navigator.limit;

            // Record the current search query
            search_info.result_count = hits;
            _this.trigger('query:record', search_info);

            // Propagate search results to listsearch
            var publication_numbers = response['details'];

            // Perform list search. Currently in buckets of 10.
            _this.perform_listsearch(options, query, publication_numbers, hits, 'pn', 'OR').always(function() {
                // Propagate upstream message again, because "perform_listsearch" currently clears it
                // TODO: Improve these mechanics!
                _this.propagate_datasource_message(response, options);
            });

        }).fail(function(xhr) {

            _this.trigger('search:failure', search_info);

            if (xhr.status == 404) {

                // Propagate zero result count
                _this.metadata.set('result_count', 0);

                // Display "No results" notification
                _this.ui.no_results_alert(search_info);

            } else {
                // TODO: Propagate to frontend. Use "ui.user_alert" or "ui.propagate_cornice_errors"?
                console.error('Generic data search failed:', xhr);
            }

            // Signal the results are ready to run other ui setup tasks
            // e.g. Report issue machinery
            _this.trigger('results:ready');

        });

    },

    send_query: function(query, options) {
        if (query) {
            $('#query').val(query);
            opsChooserApp.perform_search(options);
            $(window).scrollTop(0);
        }
    },


    // Perform ops search and process response
    perform_listsearch: function(options, query_origin, entries, hits, field, operator) {

        options = options || {};

        // Debugging
        /*
        log('perform_listsearch.options:', options);
        log('perform_listsearch.query:  ', query_origin);
        log('perform_listsearch.entries:', entries);
        log('perform_listsearch.hits:   ', hits);
        */

        // Filter empty elements from entries
        entries = _.filter(entries, function(entry) {
            return !_.isEmpty(_.string.trim(entry));
        });

        // Querying by single document numbers has a limit of 10 at OPS
        var page_size = 10;
        this.metadata.set('page_size', page_size);
        options.local_limit = page_size;

        // set parameter to control subsearch
        this.metadata.set('searchmode', 'subsearch');

        //this.set_datasource('ops');


        this.ui.indicate_activity(false);
        this.ui.reset_content();
        //this.ui.reset_content({keep_pager: true, documents: true});

        if (_.isEmpty(entries)) {

            console.warn('Empty entries when performing listsearch at OPS');

            // Display "No results" warning
            var datasource = options.datasource || (options.query_data && options.query_data.datasource);
            this.ui.no_results_alert({datasource: datasource, query: query_origin});

            // Signal the results are (not) ready
            this.trigger('results:ready');

            // Return something async void
            var deferred = $.Deferred();
            deferred.resolve();
            return deferred.promise();
        }


        // compute slice values
        var range = options && options.range ? options.range : '1-10';
        //console.log('range:', range);
        var range_parts = range.split('-');
        var sstart = parseInt(range_parts[0]) - 1;
        var ssend = parseInt(range_parts[1]);

        if (options && options.remote_limit) {
            log('slice options.remote_limit:', options.remote_limit);
            sstart = sstart % options.remote_limit;
            ssend = ssend % options.remote_limit;
            if (ssend == 0) {
                ssend = options.remote_limit - 1;
            }
        }
        console.log('local slices:', sstart, ssend);

        // TODO: Get rid of this!?
        if (entries && (entries.length == 0 || sstart > entries.length)) {

            var deferred = $.Deferred();
            deferred.resolve();

            //self.metadata.set('result_count', 0);

            if (_.isEmpty(query_origin) && _.isEmpty(entries)) {
                this.ui.reset_content({keep_pager: false, documents: true});
                this.ui.user_alert('No results.', 'info');
                return deferred.promise();
            }

        }

        // ------------------------------------------
        //   metadata propagation
        // ------------------------------------------
        var _this = this;
        var propagate_metadata = function() {

            // Display original query
            _this.metadata.set('query_origin', query_origin);

            // Override with original result count
            _this.metadata.set('result_count', hits);

            // Amend result range and paging parameter
            _this.metadata.set('result_range', range);

            // FIXME: WTF - 17?
            _this.metadata.set('pagination_entry_count', 17);

        };


        // result entries to display
        var entries_sliced = entries.slice(sstart, ssend);
        //log('entries_sliced:', entries_sliced);

        // Propagate local hit count
        options.local_hits = entries_sliced.length;


        // If there are no results after slicing, skip searching at OPS,
        // but pretend by making up metadata in the same way.
        if (_.isEmpty(entries_sliced)) {

            console.warn('Empty sliced entries when performing listsearch at OPS');

            propagate_metadata();

            this.documents.reset();

            // Signal the results are (not) ready
            this.trigger('results:ready');

            // Return something async void
            var deferred = $.Deferred();
            deferred.resolve();
            return deferred.promise();
        }


        // propagate to generic result collection view
        if (!_.isEmpty(entries_sliced) && _.isObject(entries_sliced[0])) {
            try {
                this.results.reset(entries_sliced);
            } catch (ex) {
                console.warn('Problem propagating data to results collection:', ex);
                //throw(ex);
            }
        } else {
            this.results.reset();
        }

        // compute list of requested publication numbers for this slice
        var publication_numbers = _.map(entries_sliced, function(entry) {
            var number;
            if (_.isObject(entry)) {
                number = entry['publication_number'];
            } else if (!_.isEmpty(entry)) {
                number = entry;
            }
            return number;
        });
        //log('publication_numbers:', publication_numbers);


        // compute query expression to display documents from OPS
        var query_ops_constraints = _(_.map(publication_numbers, function(publication_number) {
            if (publication_number) {
                // 2016-04-23: Do it without quotes. Does this break anything?
                //return field + '=' + '"' + _.string.trim(publication_number, '"') + '"';
                return field + '=' + _.string.trim(publication_number, '"');
            }
        }));
        var query_ops_cql = query_ops_constraints.join(' ' + operator + ' ');
        console.log('OPS CQL query:', query_ops_cql);

        if (!query_origin) {
            query_origin = query_ops_cql;
        }

        //$('#query').val(query_origin);


        // for having a reference to ourselves in nested scopes
        var self = this;
        var _this = this;

        // establish comparator to bring collection items into same order of upstream result list
        // TODO: decouple/isolate this behavior from "global" scope, i.e. this is not reentrant
        this.documents_apply_comparator(publication_numbers);

        //var range = this.compute_range(options);
        return this.search.perform(this.documents, this.metadata, query_ops_cql, '1-10', {silent: true}).always(function() {

            // ------------------------------------------
            //   metadata propagation
            // ------------------------------------------
            propagate_metadata();


            // ------------------------------------------
            //   placeholders
            // ------------------------------------------
            // add placeholders for missing documents to model
            _this.documents_add_placeholders(publication_numbers);


            // ------------------------------------------
            //   data propagation / rendering
            // ------------------------------------------
            // trigger re-rendering through model-change
            _this.documents.trigger('reset', _this.documents);


            // ------------------------------------------
            //   housekeeping
            // ------------------------------------------
            // undefine comparator after performing action in order not to poise other queries
            // TODO: decouple/isolate this behavior from "global" scope, i.e. this is not reentrant
            self.documents.comparator = undefined;


            // ------------------------------------------
            //   ui tuning
            // ------------------------------------------
            $('.pagination').removeClass('span10');
            $('.pagination').addClass('span12');

            // TODO: selecting page size with DEPATISnet is currently not possible
            //$('.page-size-chooser').parent().remove();


            // ------------------------------------------
            //   downstream signalling
            // ------------------------------------------

            // propagate list of found document numbers to results collection
            // in order to make it possible to indicate which documents are missing
            self.results.set_reference_document_numbers(self.documents.get_document_numbers());
            self.results.set_placeholder_document_numbers(self.documents.get_placeholder_document_numbers());

            // signal the results are ready
            self.trigger('results:ready');

        });

    },

    // comparator to bring collection items into same order of upstream result list
    documents_apply_comparator: function(documents_requested) {

        // TODO: decouple/isolate this behavior from "global" scope, i.e. this is not reentrant
        this.documents.comparator = function(document) {

            var debug = false;

            // get document number
            // TODO: maybe use .get_document_id() ?
            var document_id_full = document.get('@country') + document.get('@doc-number') + document.get('@kind');
            debug && log('document_id_full:', document_id_full);


            // 1. Compare against document numbers _with_ kindcode
            var index = findIndex(documents_requested, function(item) {
                return _.string.startsWith(item, document_id_full);
            });
            debug && log('index-1', index);
            if (index != undefined) return index;


            // 2. Fall back to compare against document numbers w/o kindcode
            var document_id_short = document.get('@country') + document.get('@doc-number');
            index = findIndex(documents_requested, function(item) {
                return _.string.startsWith(item, document_id_short);
            });
            debug && log('index-2', index);
            if (index != undefined) return index;

            // 3. again, fall back to compare against full-cycle neighbors
            var full_cycle_numbers_full = document.attributes.get_full_cycle_numbers();
            var full_cycle_numbers = _.difference(full_cycle_numbers_full, [document_id_full]);

            // check each full-cycle member ...
            _.each(full_cycle_numbers, function(full_cycle_number) {
                var full_cycle_number_nokindcode = patent_number_strip_kindcode(full_cycle_number);
                // ... if it exists in list of requested documents
                var index_tmp = findIndex(documents_requested, function(document_requested) {

                    var outcome =
                        _.string.startsWith(document_requested, full_cycle_number) ||
                        _.string.startsWith(document_requested, full_cycle_number_nokindcode);
                    return outcome;
                });
                if (index_tmp != undefined) {
                    index = index_tmp;
                }
            });
            debug && log('index-3', index);
            if (index != undefined) return index;

            // 4. if not found yet, put it to the end of the list
            if (self.documents) {
                index = self.documents.length;
            }
            debug && log('index-4', index);
            if (index != undefined) return index;

        }

    },

    // add placeholders for missing documents to model
    documents_add_placeholders: function(documents_requested) {

        var debug = false;

        // list of requested documents w/o kindcode
        var documents_requested_kindcode = documents_requested;
        var documents_requested_nokindcode = _.map(documents_requested, patent_number_strip_kindcode);

        debug && log('documents_requested_kindcode:', documents_requested_kindcode);
        debug && log('documents_requested_nokindcode:', documents_requested_nokindcode);

        // list of documents in response with and w/o kindcode
        var documents_response_kindcode = [];
        var documents_response_nokindcode = [];

        // full-cycle publication numbers per document
        var documents_full_cycle_map = {};

        // which documents have been swapped?
        var documents_swapped = {};

        // collect information from response documents
        this.documents.each(function(document) {
            var document_id_kindcode = document.get('@country') + document.get('@doc-number') + document.get('@kind');
            var document_id_nokindcode = document.get('@country') + document.get('@doc-number');
            documents_response_kindcode.push(document_id_kindcode);
            documents_response_nokindcode.push(document_id_nokindcode);

            // build map for each number knowing its full-cycle neighbours
            var full_cycle_numbers_full = document.attributes.get_full_cycle_numbers();
            _.each(full_cycle_numbers_full, function(number) {
                if (!documents_full_cycle_map[number]) {
                    var full_cycle_numbers = _.difference(full_cycle_numbers_full, [number]);
                    documents_full_cycle_map[number] = full_cycle_numbers;
                }
            });

            if (document.get('__meta__')) {
                var swapped = document.get('__meta__')['swapped'];
                if (swapped) {
                    _.each(swapped['list'], function(item) {
                        documents_swapped[item] = true;
                    });
                }
            }
        });
        var document_numbers_swapped = _.keys(documents_swapped);

        debug && log('documents_response_kindcode:', documents_response_kindcode);
        debug && log('documents_response_nokindcode:', documents_response_nokindcode);
        debug && log('documents_full_cycle_map:', documents_full_cycle_map);
        debug && log('document_numbers_swapped:', document_numbers_swapped);


        // compute list of missing documents with local alternatives

        // v1: naive
        //var documents_missing = _.difference(documents_requested, documents_response);

        // v2: sophisticated
        var documents_missing = [];
        _.each(documents_requested_kindcode, function(document_requested_kindcode) {

            var document_requested_nokindcode = patent_number_strip_kindcode(document_requested_kindcode);

            // compare with kindcodes
            var result_found =
                _.contains(documents_response_kindcode, document_requested_kindcode);

            // optionally, also compare without kindcodes
            if (document_requested_kindcode == document_requested_nokindcode) {
                result_found =
                    result_found ||
                    _.contains(documents_response_nokindcode, document_requested_nokindcode);
            }

            // Don't display swapped documents as missing
            if (_.contains(document_numbers_swapped, document_requested_kindcode) ||
                _.contains(document_numbers_swapped, document_requested_nokindcode)) {
                result_found = true;
            }

            if (!result_found) {

                // Compute alternatives
                var alternatives = [];


                // 1. Numbers w/o kindcode
                var nokindcode = _.filter(documents_response_kindcode, function(item) {
                    return _.string.startsWith(item, document_requested_nokindcode);
                });
                Array.prototype.push.apply(alternatives, nokindcode);


                // 2. Documents from full-cycle neighbours
                var full_cycle_numbers = documents_full_cycle_map[document_requested_kindcode];
                // Fall back searching the full-cycle map w/o kindcodes
                if (_.isEmpty(full_cycle_numbers)) {
                    _.each(documents_full_cycle_map, function(value, key) {
                        if (_.string.startsWith(key, document_requested_nokindcode)) {
                            full_cycle_numbers = value;
                        }
                    });
                }
                if (!_.isEmpty(full_cycle_numbers)) {
                    Array.prototype.push.apply(alternatives, full_cycle_numbers);
                }


                // 3. Be graceful to WO anomalies like WO2003049775A2 vs. WO03049775A2
                var wo_alternatives = [];
                if (_.string.startsWith(document_requested_kindcode, "WO")) {
                    wo_alternatives = _.filter(documents_response_kindcode, function(item) {
                        // Denormalize WO number
                        var wo_number = document_requested_kindcode.slice(2, -2);
                        var wo_kindcode = document_requested_kindcode.slice(-2);
                        // Strip century component from 4-digit year
                        var wo_short = 'WO' + wo_number.slice(2) + wo_kindcode;
                        return _.string.startsWith(item, wo_short);
                    });
                }
                Array.prototype.push.apply(alternatives, wo_alternatives);


                // per-document response
                var document_missing = {
                    'number': document_requested_kindcode,
                    'alternatives_local':_.unique(alternatives),
                };

                documents_missing.push(document_missing);
            }

        });
        debug && log('documents_missing:', documents_missing);


        // Skip updating the collection of documents if nothing would change
        if (_.isEmpty(documents_missing)) {
            return;
        }

        // inject placeholder objects for all missing documents
        var _this = this;
        _.each(documents_missing, function(document_missing) {

            // split patent number into components
            var patent = split_patent_number(document_missing.number);

            // inject placeholder model
            _this.documents.add(new GenericExchangeDocument({
                '__type__': 'ops-placeholder',
                '@country': patent.country,
                '@doc-number': patent.number,
                '@kind': patent.kind,
                'alternatives_local': document_missing.alternatives_local,
            }), {sort: false});
        });
        //log('documents:', this.documents);

        // sort documents in bulk
        if (this.documents.comparator) {
            this.documents.sort();
        }

    },

    // initialize model from url query parameters ("numberlist")
    parse_numberlist: function(payload) {
        if (!_.isEmpty(payload)) {
            var fieldname;
            var parts = payload.split(/=/);
            if (parts.length == 1) {
                fieldname = 'pn';
                payload   = parts[0];
            } else if (parts.length == 2) {
                fieldname = parts[0];
                payload   = parts[1];
            }
            var numberlist = _(payload.split(/[,\n]/)).map(function(entry) {
                return entry.trim();
            }).filter(function(entry) {
                return !(_.isEmpty(entry) || _.string.startsWith(entry, '//') || _.string.startsWith(entry, '#'));
            });
            return {data: numberlist, fieldname: fieldname};
        }
    },

    perform_numberlistsearch: function(options) {
        //log('perform_numberlistsearch');
        var numberlist = this.parse_numberlist($('#numberlist').val());
        if (numberlist) {

            // Reset pager and more before kicking off numberlist search
            this.metadata.resetSomeDefaults(options);

            var _this = this;
            normalize_numberlist(numberlist.data.join(',')).then(function(normalized) {
                var numbers_normalized = normalized['numbers-normalized']['all'];
                //log('numbers_normalized:', numbers_normalized);

                //var publication_numbers = numberlist.data;
                var publication_numbers = numbers_normalized || numberlist.data;
                var hits = publication_numbers.length;

                // actually perform the listsearch
                _this.perform_listsearch(options, undefined, publication_numbers, hits, numberlist.fieldname, 'OR');
            });
        } else {
            this.ui.notify("An empty numberlist can't be requested, please add some publication numbers.", {type: 'warning', icon: 'icon-align-justify'});
        }
    },

    compute_range: function(options) {
        var page_size = this.metadata.get('page_size');
        var default_range = '1-' + page_size;
        var range = options && options.range ? options.range : default_range;
        return range;
    },

    propagate_datasource_message: function(response, options) {

        options = options || {};

        log('propagate_datasource_message');

        // Generic backend message
        var bucket = undefined;
        response && response.navigator && (bucket = response.navigator.user_info);
        if (_.isObject(bucket)) {
            this.ui.user_alert(bucket.message, bucket.kind);

        } else if (_.isString(bucket)) {
            this.ui.user_alert(bucket, 'info');
        }

        if (response.message) {
            this.ui.user_alert(response.message, 'warning');
        }

        this.propagate_datasource_signals(response, options);
    },

    propagate_datasource_signals: function(response, options) {

        options = options || {};

        // Special purpose user information signalling

        // 1. Feature "Remove family members"
        var meta = response.meta;
        if (meta && meta.navigator && meta.navigator.postprocess && meta.navigator.postprocess.action == 'feature_family_remove') {

            // How many documents have actually been removed on this result page?
            var count_removed = meta.navigator.postprocess.info.removed;

            // Get information from pager
            var offset = meta.navigator.offset;
            var limit  = meta.navigator.limit;

            // Compute ratio of removed family members vs. total results on this result page
            var family_removed_ratio = count_removed / meta.navigator.count_page;

            // Compute estimated total savings on documents to review
            var count_total           = meta.navigator.count_total;
            var count_total_estimated = count_total * (1 - family_removed_ratio);
            var count_saved_estimated = count_total - count_total_estimated;

            // Propagate informational data to user
            var tpldata = {
                start: offset + 1,
                end:   offset + limit,
                count_removed: count_removed,
                count_total_estimated: Math.floor(count_total_estimated),
                count_saved_estimated: Math.floor(count_saved_estimated),
                family_members_removed: response.navigator.family_members.removed,
                chunksize: meta.navigator.limit,
            };

            if (count_removed > 0) {
                var info_body = _.template($('#family-members-removed-some-template').html(), tpldata, {variable: 'data'});
            } else {
                var info_body = _.template($('#family-members-removed-none-template').html(), tpldata, {variable: 'data'});
            }
            this.ui.user_alert(info_body, 'info');

            // Display additional information when reaching empty result pages
            if (options.local_hits == 0 && options.local_limit && options.range_end && options.remote_limit) {
                var recommended_next_page_remote =
                    ((Math.floor((options.range_end - 1) / options.remote_limit) + 1) * options.remote_limit) + 1;
                var recommended_next_page_local =
                    Math.floor(recommended_next_page_remote / options.local_limit) + 1;

                var max_page_local = opsChooserApp.paginationViewBottom.get_max_page();
                var has_more_results = recommended_next_page_local <= max_page_local;

                if (has_more_results) {
                    tpldata.recommended_next_page_local = recommended_next_page_local;
                }

                var info_body = _.template($('#family-members-removed-empty-page-template').html(), tpldata, {variable: 'data'});
                this.ui.user_alert(info_body, 'info');

                // Go to page containing next results after the gap of removed items
                if (has_more_results) {
                    $('#next-page-with-results-button').on('click', function() {
                        opsChooserApp.paginationViewBottom.set_page(recommended_next_page_local);
                    });
                }

            }
        }

    },


    // TODO: move to project.js
    project_activate: function(project) {

        var _this = this;

        if (!project) {
            console.error('project is null, will not activate');
            return;
        }

        var projectname = project.get('name');
        console.log('App.project_activate:', projectname);

        // set project active in application scope
        // TODO: can this be further decoupled?
        if (this.project) {
            this.stopListening(this.project);
            delete this.project;
        }
        this.project = project;

        // set hook to record all queries
        this.stopListening(this, 'query:record');
        this.listenTo(this, 'query:record', function(arguments) {
            project.record_query(arguments);
        });

        // trigger project reload when window gets focus
        // FIXME: this interferes with rating actions into unfocused windows
        $(window).off('focus', this.project_reload);
        $(window).on('focus', this.project_reload);

        // setup views
        // TODO: refactor using a Marionette Region
        if (this.projectChooserView) {
            this.projectChooserView.stopListening();
        }
        this.projectChooserView = new ProjectChooserView({
            el: $('#project-chooser-area'),
            model: project,
            collection: project.collection,
        });
        this.projectChooserView.render();

        // activate storage actions
        this.storage.setup_ui();

        // activate permalink actions
        this.permalink.setup_ui();

        // update project information metadata display
        $('#ui-project-name').html(
            'Review for project "' + project.get('name') + '".'
        );
        $('#ui-project-dates').html(
            'Created ' + moment(project.get('created')).fromNow() + ', ' +
            'modified ' + moment(project.get('modified')).fromNow() + '.'
        );
        $('#ui-opaquelink-expiry').html(
            'Link expires ' + moment(this.config.get('link_expires')).fromNow() + '.'
        );


        // Also update current application configuration model.
        // Be aware that the basket is not properly initialized yet at this point.
        // So potential listeners to configuration model change events currently
        // must not expect a *fully* initialized project/basket structure.
        // 2016-05-02: Now updating config model after fetching the basket.
        var register_project = function() {
            _this.config.set('project', project.get('name'));
        }

        // activate basket
        var basket = project.get('basket');

        // refetch basket to work around localforage.backbone vs. backbone-relational woes
        // otherwise, data storage mayhem may happen, because of model.id vs. model.sync.localforageKey mismatch
        // FIXME: it's ridiculous that we don't receive stacktraces from within "then()"
        basket.fetch({
            success: function() {
                $.when(basket.fetch_entries()).then(function() {
                    _this.basket_activate(basket);
                    register_project();
                });
            },
            error: function(e, error) {
                console.error('Error while fetching basket object for project "' + projectname + '":', e, error);
                _this.basket_deactivate();
                register_project();
            },
        });

    },

    project_deactivate: function() {
        $(window).off('focus', this.project_reload);
    },

    project_reload: function() {
        // reload project
        var projectname = opsChooserApp.project.get('name');
        opsChooserApp.trigger('project:load', projectname);
    },

    // TODO: move to basket.js
    basket_deactivate: function() {

        // TODO: how to decouple this? is there something like a global utility registry?
        // TODO: is old model killed properly?
        if (this.basketModel) {
            this.stopListening(this.basketModel);
            delete this.basketModel;
        }

        // TODO: is old view killed properly?
        // https://stackoverflow.com/questions/14460855/backbone-js-listento-window-resize-throwing-object-object-has-no-method-apply/17472399#17472399
        if (this.basketView) {
            this.basketView.close();
            this.stopListening(this.basketView);
            //this.basketView.destroy();
            //this.basketView.remove();
            delete this.basketView;
        }
    },

    basket_activate: function(basket) {

        console.log('App.basket_activate');

        if (!basket) {
            console.error('basket is null, will not activate');
            return;
        }

        this.basket_deactivate();

        // A. model and view
        this.basketModel = basket;
        this.basketView = new BasketView({
            //el: $('#basket-area'),
            model: basket,
        });
        this.basketRegion.show(this.basketView);


        // B. event listeners

        // toggle appropriate Add/Remove button when entries get added or removed from basket
        // TODO: are old bindings killed properly?
        // FIXME: this stopListening is brutal!
        this.stopListening(null, "change:add");
        this.stopListening(null, "change:remove");
        this.stopListening(null, "change:rate");
        this.listenTo(basket, "change:add", this.basketController.link_document);
        this.listenTo(basket, "change:remove", this.basketController.link_document);
        this.listenTo(basket, "change:rate", this.basketController.link_document);

        // save project when basket changed to update the "modified" attribute
        this.stopListening(null, "change");
        this.listenTo(basket, "change", function() {
            this.project.save();
        });

        // focus added number in basket
        this.listenTo(basket, "change:add", function(entry, number) {
            this.basketView.textarea_scroll_text(number);
        });



        // C. user interface
        this.basketView.render();

        // update some other gui components after basket view is ready
        this.basket_bind_actions();

        this.trigger('basket:activated', basket);

    },

    basket_bind_actions: function() {

        // TODO: maybe use an event handler for this, instead of a direct method call (e.g. "item:rendered")

        var _this = this;

        // handle checkbox clicks by add-/remove-operations on basket
        /*
        $(".chk-patent-number").click(function() {
            var patent_number = this.value;
            if (this.checked)
                _this.basketModel.add(patent_number);
            if (!this.checked)
                _this.basketModel.remove(patent_number);
        });
        */

        // handle button clicks by add-/remove-operations on basket
        $(".add-patent-number").unbind('click');
        $(".add-patent-number").click(function() {
            var patent_number = $(this).data('patent-number');
            _this.basketModel.add(patent_number);
        });
        $(".remove-patent-number").unbind('click');
        $(".remove-patent-number").click(function() {
            var patent_number = $(this).data('patent-number');
            _this.basketModel.remove(patent_number);
        });

        // handle "add all documents"
        $("#basket-add-all-documents").unbind('click');
        $("#basket-add-all-documents").click(function() {
            // collect all document numbers
            _this.documents.each(function(document) {
                var number = document.attributes.get_patent_number();
                _this.basketModel.add(number, {'reset_seen': true});
            });

        });

        // setup rating widget
        console.log('setup rating widget');
        //$('.rating-widget').raty('destroy');
        $('.rating-widget').raty({
            number: 3,
            hints: ['slightly relevant', 'relevant', 'important'],
            cancel: true,
            cancelHint: 'not relevant',
            dismissible: true,
            path: '/static/widget/raty/img',
            action: function(data, evt) {
                var score = data.score;
                var dismiss = data.dismiss;
                var document_number = $(this).data('document-number');
                _this.document_rate(document_number, score, dismiss);
            },
        });

        // propagate basket contents to Add/Remove button states once when activating the basket
        // TODO: do this conditionally - only if Basket is enabled
        this.documents.each(function(document) {
            var number = document.attributes.get_patent_number();
            if (_this.basketModel) {
                var entry = _this.basketModel.get_entry_by_number(number);
                _this.basketController.link_document(entry, number);
            } else {
                _this.basketController.link_document(undefined, number);
            }
        });

    },


    document_rate: function(document_number, score, dismiss) {
        var _this = this;
        if (document_number) {
            this.basketModel.add(document_number).then(function(item) {
                item.save({score: score, dismiss: dismiss, seen: undefined}, {
                    success: function() {
                        _this.basketModel.trigger('change:rate', item, document_number);
                        _this.basketView.textarea_scroll_text(document_number);

                    }, error: function() {
                        console.error('rating save error', document_number, item);
                    }
                });

            });
        }
    },

    document_seen_twice: function(document_number) {

        if (!this.basketModel) {
            throw new BasketError('Basket not active');
        }

        // skip saving as "seen" if already in basket
        if (this.basketModel.exists(document_number)) {

            // if we occur the document a second time, mark as seen visually by increasing opacity
            var basket = this.basketModel.get_entry_by_number(document_number);
            if (basket.get('seen')) {
                return true;
            }

        }

        return false;
    },

    document_mark_seen: function(document_number) {
        var _this = this;

        if (!document_number) {
            return;
        }

        if (!this.basketModel) {
            throw new BasketError('Basket not active');
        }

        // skip saving as "seen" if already in basket
        if (this.basketModel.exists(document_number)) {
            return;
        }

        //log('document_mark_seen:', document_number);

        this.basketModel.add(document_number).then(function(item) {

            item.set('seen', true);
            //item.set('seen', true, { silent: true });

            item.save(null, {
                success: function() {

                    //console.info('"seen" save success', document_number, item);

                    // don't backpropagate in realtime, this would probably immediately color the document gray
                    //_this.basketModel.trigger('change:rate', item, document_number);

                }, error: function() {
                    console.error('"seen" save error', document_number, item);
                }
            });

        });

    },


    // tear down user interface, clear all widgets
    shutdown_gui: function() {

        // basket and associated document indicators
        this.basketModel && this.basketModel.destroy();
        this.basket_bind_actions();
        this.basketView && this.basketView.render();

        // comments
        this.comments.store.set();

        // projects
        this.projects.reset();

        // Shutdown project choose, being graceful against timing issues re. object lifecycle
        if (this.projectChooserView) {
            this.projectChooserView.clear();
        }

    },

    user_has_module: function(module) {
        var module_abo = _(this.config.get('user.modules')).contains(module);
        var development_mode = this.config.get('request.host_name') == 'localhost';
        return module_abo || development_mode;
    },

});


/**
 * ------------------------------------------
 *           bootstrap application
 * ------------------------------------------
 */

console.info('Load application components');

opsChooserApp = new OpsChooserApp({config: navigatorConfiguration, theme: navigatorTheme});

opsChooserApp.addRegions({
    mainRegion: "#main-region",
    queryBuilderRegion: "#querybuilder-region",
    basketRegion: "#basket-region",
    metadataRegion: "#ops-metadata-region",
    listRegion: "#ops-collection-region",
    paginationRegionTop: "#ops-pagination-region-top",
    paginationRegionBottom: "#ops-pagination-region-bottom",
});


// Main application user interface
opsChooserApp.addInitializer(function(options) {

    //this.theme = new ApplicationTheme({config: navigatorConfiguration});
    //log('this.applicationTheme:', this.applicationTheme);

    this.layoutView = new LayoutView();
    this.mainRegion.show(this.layoutView);

});

// Universal helpers
opsChooserApp.addInitializer(function(options) {
    this.issues = new IssueReporterGui();
    this.listenTo(this, 'application:ready', function() {
        this.issues.setup_ui();
    });
    this.listenTo(this, 'results:ready', function() {
        this.issues.setup_ui();
    });
});

// Data storage components
opsChooserApp.addInitializer(function(options) {
    this.storage = new StoragePlugin();

    this.listenTo(this, 'application:ready', function() {
        this.storage.setup_ui();
    });

    this.listenTo(this, 'results:ready', function() {
        this.storage.setup_ui();
    });
});
opsChooserApp.addInitializer(function(options) {

    // Set driver (optional)
    // We use Local Storage here to make introspection easier.
    // TODO: disable on production
    localforage.setDriver('localStorageWrapper');

    // set database name from "context" query parameter
    localforage.config({name: this.config.get('context')});

    // import database from url :-)
    // TODO: i'd like this to have storage.js make it on its own, but that'd be too late :-(
    //       check again what we could achieve...
    var database_dump = this.config.get('database');
    if (database_dump) {

        // When importing a database dump, we assign "context=viewer" a special meaning here:
        // the database scope will always be cleared beforehand to avoid project name collisions.
        // Ergo the "viewer" context is considered a *very transient* datastore.
        if (this.config.get('context') == 'viewer') {
            this.storage.dbreset();
        }

        // TODO: project and comment loading vs. application bootstrapping are not synchronized yet
        this.LOAD_IN_PROGRESS = true;

        // TODO: resolve project name collisions!
        this.storage.dbimport(database_dump);
    }

});

// initialize models
opsChooserApp.addInitializer(function(options) {

    // application domain model objects
    this.search = new OpsPublishedDataSearch();
    this.metadata = new OpsExchangeMetadata();
    this.documents = new OpsExchangeDocumentCollection();
    this.results = new ResultCollection();

});

// initialize views
opsChooserApp.addInitializer(function(options) {

    // bind model objects to view objects
    this.metadataView = new MetadataView({
        model: this.metadata
    });
    this.collectionView = new OpsExchangeDocumentCollectionView({
        collection: this.documents
    });
    this.resultView = new ResultCollectionView({
        collection: this.results
    });

    this.paginationViewTop = new PaginationView({
        model: this.metadata
    });
    this.paginationViewBottom = new PaginationView({
        model: this.metadata,
        bottom_pager: true,
    });

    // bind view objects to region objects
    this.metadataRegion.show(this.metadataView);
    this.paginationRegionTop.show(this.paginationViewTop);
    this.paginationRegionBottom.show(this.paginationViewBottom);
});

// activate anonymous basket (non-persistent/project-associated)
opsChooserApp.addInitializer(function(options) {
    // remark: the model instance created here will get overwritten later
    //         by a project-specific basket when activating a project
    // reason: we still do it here for the case we decide to deactivate the project
    //         subsystem in certain modes (dunno whether this will work out)
    // update [2014-06-08]: deactivated anonymous basket until further
    //this.basket_activate(new BasketModel());
});


// Main component event wiring
opsChooserApp.addInitializer(function(options) {

    // Application core, first stage boot process
    this.listenTo(this, 'application:boot', function() {

        console.info('Load main application (application:boot)');

        this.setup_ui();

        // Propagate "datasource" query parameter
        var datasource = this.config.get('datasource');
        if (datasource) {
            this.set_datasource(datasource);
        }

        // Activate regular list region right now to avoid double rendering on initial page load
        this.listRegion.show(this.collectionView);

        // Hide pagination- and metadata-area to start from scratch
        this.ui.reset_content();

        // Propagate opaque error messages to alert area
        propagate_opaque_errors();

        // Enter second stage boot process
        this.trigger('application:ready');

        this.ui.do_element_visibility();

    });

    // Activate project as soon it's loaded from the datastore
    this.listenTo(this, "project:ready", this.project_activate);


    // Results were fetched, take action
    this.listenTo(this, 'results:ready', function() {

        // commit metadata, this will trigger e.g. PaginationView rendering
        this.metadata.trigger('commit');

        // show documents (ops results) in collection view
        // explicitly switch list region to OPS collection view
        if (this.listRegion.currentView !== this.collectionView) {
            this.listRegion.show(this.collectionView);
        }

    });


});

// Kick off the search process triggered from query parameters
opsChooserApp.addInitializer(function(options) {

    // Just wait for project activation since this is a dependency before running
    // a search because the query history is associated to the project.
    this.listenToOnce(this, "project:ready", function() {

        // Propagate search modifiers from query parameters to search engine metadata
        this.permalink.parameters_to_metadata();

        // Propagate search modifiers from search engine metadata to user interface
        var query_data = this.metadata.get('query_data');
        if (query_data) {
            this.queryBuilderView.set_common_form_data(query_data);
        }

        // The ui loading and lag woes are ready after the basket was fully initialized
        this.listenToOnce(this, "basket:activated", function() {
            // Run search
            this.perform_search();
        });

    });

});
