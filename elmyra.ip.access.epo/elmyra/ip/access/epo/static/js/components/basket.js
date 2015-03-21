// -*- coding: utf-8 -*-
// (c) 2013,2014 Andreas Motl, Elmyra UG

BasketModel = Backbone.RelationalModel.extend({

    sync: Backbone.localforage.sync('Basket'),

    relations: [
        {
            type: Backbone.HasMany,
            key: 'entries',
            relatedModel: 'BasketEntryModel',
            includeInJSON: Backbone.Model.prototype.idAttribute,

            // reverseRelation *must not* be defined for HasMany relationships, otherwise this will yield
            // empty collections unconditionally, especially after creating new parent objects
            /*
            reverseRelation: {
                type: Backbone.One,
                key: 'basket',
                // 'relatedModel' is automatically set to 'ProjectModel'
                includeInJSON: Backbone.Model.prototype.idAttribute,
            },
            */

        }
    ],

    defaults: {
    },

    initialize: function() {
        console.log('BasketModel.initialize');

        // backbone-relational backward-compat
        if (!this.fetchRelated) this.fetchRelated = this.getAsync;

        // memoize results of "get_numbers"
        this.wrap_cache('get_numbers');

    },

    // memoize results of method, invalidating cache on model change
    wrap_cache: function(funcname, context) {
        context = context || this;
        this[funcname] = memoize(this[funcname], this);
        this.invalidate_cache = function() {
            this[funcname].__cache.remove();
        };
        this.bind('change', this.invalidate_cache);
    },

    // initialize model from url query parameters ("numberlist")
    init_from_query: function() {
        var deferreds = [];
        var _this = this;

        var numberlist = opsChooserApp.config.get('numberlist');

        if (numberlist) {
            numberlist = decodeURIComponent(numberlist);
            var entries = numberlist.split(/[,\n]/);
            _(entries).each(function(entry) {
                var deferred = _this.add(entry);
                deferreds.push(deferred);
            });
        }

        // wait for all add operations to finish before signalling success
        return deferreds_bundle(deferreds);
    },

    get_entry_by_number: function(item) {
        var entrymodels = this.get('entries').where({number: item});
        if (_.isEmpty(entrymodels)) {
            return;
        } else {
            return entrymodels[0];
        }
    },

    // add item to basket
    add: function(number, options) {

        options = options || {};

        var _this = this;

        number = number.trim();
        if (_.isEmpty(number)) return;

        var deferred = $.Deferred();

        var entry = this.get_entry_by_number(number);
        if (entry) {

            // refetch entry to work around localforage.backbone vs. backbone-relational woes
            // otherwise, data storage mayhem may happen, because of model.id vs. model.sync.localforageKey mismatch
            entry.fetch({success: function() {
                deferred.resolve(entry);

                // refresh gui, update timestamp
                !options.bulk && _this.trigger('change', _this);
            }});

            return deferred.promise();
        }

        // get title of selected document
        // TODO: maybe prebuild/maintain an index in collection
        var document = _.find(opsChooserApp.documents.models, function(doc) {
            var document_number = doc.get_document_number();
            return number == document_number;
        });
        var title = document ? document.attributes.get_title_list() : undefined;

        // build basket entry
        entry = new BasketEntryModel({
            number: number,
            timestamp: now_iso(),
            title: title,
            /*basket: this,*/
            /*query: null,*/
        });

        // save basket entry
        entry.save(null, {success: function() {
            var entries = _this.get('entries');
            entries.add(entry);
            _this.save({'entries': entries}, {
                success: function() {
                    if (options.bulk) {
                        deferred.resolve(entry);
                    } else {
                        $.when(_this.fetch_entries()).then(function() {
                            //deferred.resolve(entry);
                            deferred.resolve(_this.get_entry_by_number(entry.get('number')));
                            _this.trigger('change', _this);
                            _this.trigger('change:add', entry, number);
                        });
                    }
                },
            });
        }});

        return deferred.promise();
    },

    add_multi: function(numberlist) {

        var deferred = $.Deferred();

        var _this = this;
        var deferreds = [];
        _.each(numberlist, function(number) {
            deferreds.push(_this.add(number, {bulk: true}));
        });
        $.when.apply($, deferreds).then(function() {
            _this.refresh();
            deferred.resolve();
        });

        return deferred.promise();
    },

    refresh: function() {
        var _this = this;
        $.when(this.fetch_entries()).then(function() {
            _this.trigger('change');
        });
    },

    // remove item from basket
    remove: function(number) {
        var _this = this;

        var entry = this.get_entry_by_number(number);
        if (!entry) {
            return;
        }

        var entries = this.get('entries');
        entries.remove(entry);
        entry.destroy();
        _this.save({'entries': entries}, {success: function() {
            $.when(_this.fetch_entries()).then(function() {
                _this.trigger('change:remove', entry, number);
                _this.trigger('change', _this);
            });
        }});
    },

    get_numbers: function(options) {
        options = options || {};
        var numbers = _.reject(this.get('entries').models, function(entry) {
            if (options.honor_dismiss) {
                return entry.get('dismiss') == true;
            }
            return false;
        }).map(function(entry) {
            return entry.get('number');
        });
        return numbers;
    },

    empty: function() {
        return this.get('entries').length == 0;
    },

    csv_list: function() {
        return this.get('entries').map(function(entry) {
            var parts = [
                entry.get('number'),
                entry.get('score'),
                entry.get('dismiss')
            ];
            var line = parts.join(',');
            return line;
        });
    },

    unicode_stars_list: function() {
        return this.get('entries').map(function(entry) {
            var line =
                    _.string.ljust(entry.get('number'), 20, ' ') +
                    _.string.ljust(entry.get('dismiss') ? '∅' : '', 5, ' ') +
                    _.string.repeat('★', entry.get('score'));
            return line;
        });
    },

    unicode_stars_list_email: function() {
        var nbsp = String.fromCharCode(160);
        return this.get('entries').map(function(entry) {
            var dismiss_and_score = (entry.get('dismiss') ? '∅' : '') + _.string.repeat('★', entry.get('score'));
            var padlen = 10 - dismiss_and_score.length * 1.7;
            var padding = _.string.repeat(nbsp, padlen);
            var line = dismiss_and_score + padding + entry.get('number');
            return line;
        });
    },

    review: function(options) {

        var publication_numbers = this.get_numbers({honor_dismiss: true});
        var hits = publication_numbers.length;

        // TODO: decouple from referencing the main application object e.g. by using events!?
        opsChooserApp.set_datasource('review');
        opsChooserApp.metadata.set('reviewmode', true);
        opsChooserApp.perform_listsearch(options, undefined, publication_numbers, hits, 'pn', 'OR');
    },

    // fetch all basket entries from datastore, one by one; this is nasty
    fetch_entries: function() {

        var _this = this;
        var main_deferred = $.Deferred();
        $.when(this.fetchRelated('entries')).then(function() {

            // TODO: refactor this to some common base class or mixin
            var deferreds = [];
            _this.get('entries').each(function(entry) {

                // prepare a deferred which will get resolved after successfully fetching an item from datastore
                var deferred = $.Deferred();
                deferreds.push(deferred.promise());

                entry.fetch({
                    success: function() {
                        deferred.resolve(entry);
                    },
                    error: function() {
                        // HACK: sometimes, the item has vanished while fetching from store, so let's recreate it
                        console.log('error while fetching basket entry:', entry);
                        entry.save(null, {
                            success: function() {
                                console.log('success');
                                deferred.resolve(entry);
                            },
                            error: function() {
                                console.log('error');
                                deferred.resolve(entry);
                            },
                        });
                    }
                });
            });

            $.when.apply($, deferreds).then(function() {
                main_deferred.resolve();
            });
        });

        return main_deferred.promise();

    },

    get_view_state: function(more) {

        more = more || {};

        var projectname = opsChooserApp.project.get('name');
        var numbers = this.get_numbers();
        var numbers_string = numbers.join(',');

        var state = {
            //mode: 'liveview',
            context: 'viewer',
            project: projectname,
            query: undefined,
            datasource: 'review',
            numberlist: numbers_string,
        };

        _(state).extend(more);

        return state;

    },

    share_email_params: function() {

        var projectname = opsChooserApp.project.get('name');
        var url = opsChooserApp.permalink.make_uri(this.get_view_state({project: 'via-email'}));

        var numbers = this.get_numbers();
        var numbers_count = numbers.length;

        var basket_csv = this.csv_list();
        var basket_stars = this.unicode_stars_list_email();

        var subject = _.template('Shared <%= count %> patent numbers through project "<%= projectname %>" at <%= date %>')({
            count: numbers_count,
            date: now_iso_human(),
            projectname: projectname,
        });

        var body_tpl = _.template($('#basket-mail-template').html().trim());
        var body = body_tpl({
            subject: subject,
            basket_plain: numbers.join('\n'),
            basket_csv: basket_csv.join('\n'),
            basket_stars: basket_stars.join('\n'),
            url: url,
        });

        var data = {
            subject: '[IPSUITE] ' + subject,
            body: body,
        };

        return data;
    },

});


BasketEntryModel = Backbone.RelationalModel.extend({

    sync: Backbone.localforage.sync('BasketEntry'),

    defaults: {
        number: undefined,
        timestamp: undefined,
        title: undefined,
        score: undefined,
        dismiss: undefined,
        // TODO: link to QueryModel
        //query: undefined,
    },

    initialize: function() {
        //console.log('BasketEntryModel.initialize');
    },
});

BasketView = Backbone.Marionette.ItemView.extend({

    template: "#basket-template",

    initialize: function() {
        //console.log('BasketView.initialize');
        this.listenTo(this.model, "change", this.render);
        this.listenTo(this, "item:rendered", this.setup_ui);
        this.templateHelpers.config = opsChooserApp.config;
    },

    templateHelpers: {},

    serializeData: function() {

        var data = {};
        data = this.model.toJSON();

        var entries = this.model.unicode_stars_list();

        if (entries) {
            data['numbers_display'] = entries.join('\n');
        }

        return data;

    },

    setup_ui: function() {
        //console.log('BasketView.setup_ui');

        var _this = this;

        // display number of entries in basket
        var entry_count = this.model.get('entries').length;
        $('.basket-entry-count').text(entry_count);

        // only enable submit button, if ship url is given
        var ship_url = opsChooserApp.config.get('ship-url');
        if (ship_url) {
            $('#basket-submit-button').removeClass('hide');
        } else {
            $('#basket-submit-button').addClass('hide');
        }

        // import clipboard content by intercepting paste event
        $('#basket').unbind('paste');
        $("#basket").on('paste', function(e) {
            e.preventDefault();
            var text = (e.originalEvent || e).clipboardData.getData('text');
            var entries = text.split(/[,;\r\n]/);
            _.each(entries, function(entry) {
                _this.model.add(entry);
            });
        });

        // basket import
        $('#basket-import-button').unbind('click');
        $('#basket-import-button').click(function(e) {
            _this.future_premium_feature();
            return false;
        });

        // review feature: trigger search from basket content
        $('.basket-review-button').unbind('click');
        $('.basket-review-button').click(function(event) {
            event.preventDefault();
            if (_this.check_empty({kind: 'review', icon: 'icon-indent-left'})) { return; }
            _this.model.review();
        });

        // submit selected documents to origin or 3rd-party system
        $('#basket-submit-button').unbind('click');
        $('#basket-submit-button').click(function() {
            if (_this.check_empty()) { return; }
            var numbers = _this.model.get_numbers();
            $('textarea#basket').val(numbers.join('\n'));
        });

        // share via mail
        $('#share-numberlist-email').unbind('click');
        $('#share-numberlist-email').click(function() {
            if (_this.check_empty()) { return; }
            var params = _this.model.share_email_params();
            var mailto_link = 'mailto:?' + jQuery.param(params).replace(/\+/g, '%20');
            //log('mailto_link:', mailto_link);
            $(this).attr('href', mailto_link);
        });

        // share via clipboard
        _ui.copy_to_clipboard('text/plain', function() {
            if (_this.check_empty()) { return; }
            var numbers = _this.model.get_numbers();
            return numbers.join('\n');
        }, {element: $('#share-numberlist-clipboard')});
        /*
        $('#share-numberlist-clipboard').unbind('click');
        $('#share-numberlist-clipboard').click(function() {
            if (_this.check_empty()) { return; }
            var numbers = _this.model.get_numbers();
        });
        */

        // share via url
        $('#share-numberlist-url').unbind('click');
        $('#share-numberlist-url').click(function() {
            if (_this.check_empty()) { return; }
            var url = opsChooserApp.permalink.make_uri(_this.model.get_view_state());
            $(this).attr('target', '_blank');
            $(this).attr('href', url);
        });

        // share via url, with ttl
        $('#share-numberlist-url-ttl').unbind('click');
        $('#share-numberlist-url-ttl').click(function(e) {

            e.preventDefault();
            e.stopPropagation();

            if (_this.check_empty()) { return; }

            var anchor = this;
            opsChooserApp.permalink.make_uri_opaque(_this.model.get_view_state({mode: 'liveview'})).then(function(url) {

                // v1: open url
                //$(anchor).attr('href', url);

                // v2: open permalink popover

                opsChooserApp.permalink.popover_show(anchor, url, {
                    title: 'External document review',
                    intro:
                        '<small>' +
                            'This offers a link for external/anonymous users to review the collected documents. ' +
                            'It will just transfer the plain numberlist without any rating scores.' +
                        '</small>',
                    ttl: true,
                });

            });
        });

        // download zip archive of pdf documents
        $('#download-documents-pdf-archive').unbind('click');
        $('#download-documents-pdf-archive').click(function() {
            if (_this.check_empty()) { return; }
            var numberlist = opsChooserApp.basketModel.get_numbers();
            //log('numberlist:', numberlist);
            $(this).attr('target', '_blank');
            $(this).attr('href', '/api/pdf/' + numberlist.join(','));
        });

        // share via document transfer
        $('#share-documents-transfer').unbind('click');
        $('#share-documents-transfer').click(function() {
            _this.future_premium_feature();
        });


        // simple permalink
        $('.permalink-review-liveview').unbind('click');
        $('.permalink-review-liveview').click(function(e) {

            e.preventDefault();
            e.stopPropagation();

            // generate permalink uri and toggle popover
            var _button = this;
            opsChooserApp.permalink.liveview_with_database_params().then(function(params) {

                // compute permalink
                var url = opsChooserApp.permalink.make_uri(params);

                // show permalink overlay
                opsChooserApp.permalink.popover_show(_button, url, {
                    intro:
                        '<small>' +
                            'This offers a persistent link to review the current project. ' +
                            'It will transfer the whole project structure including queries and basket content with rating scores.' +
                            '</small>',
                });

            });
        });

        // signed permalink with time-to-live
        $('.permalink-review-liveview-ttl').unbind('click');
        $('.permalink-review-liveview-ttl').click(function(e) {

            e.preventDefault();
            e.stopPropagation();

            // generate permalink uri and toggle popover
            var _button = this;
            opsChooserApp.permalink.liveview_with_database_params().then(function(params) {

                // compute permalink
                opsChooserApp.permalink.make_uri_opaque(params).then(function(url) {

                    // show permalink overlay
                    opsChooserApp.permalink.popover_show(_button, url, {
                        intro:
                            '<small>' +
                                'This offers a link for external/anonymous users to review the current project. ' +
                                'It will transfer the whole project structure including queries and basket content with rating scores.' +
                                '</small>',
                        ttl: true,
                    });
                });

            });

        });

    },

    check_empty: function(options) {
        options = options || {};
        var verb = 'shared';
        if (options.kind == 'review') {
            verb = 'reviewed';
        }
        if (!options.icon) {
            options.icon = 'icon-external-link';
        }
        if (this.model.empty()) {
            opsChooserApp.ui.notify(
                "An empty collection can't be " + verb + ", please add some documents.",
                {type: 'warning', icon: options.icon + ' icon-large'});
            return true;
        }
        return false;
    },

    future_premium_feature: function() {
        bootbox.dialog(
            'Available soon via subscription.', [{
                "label": 'OK',
                "icon" : 'OK',
                "callback": null,
            }],
            {header: 'Future feature'});
    },

    textarea_scroll_bottom: function() {
        $('#basket').scrollTop($('#basket')[0].scrollHeight);
    },

    textarea_scroll_text: function(text) {
        var textArea = $('#basket');
        var index = textArea.text().search(text);
        if (index) {
            textArea.scrollTop(index);
        }
    },

});

BasketController = Marionette.Controller.extend({

    initialize: function(options) {
        console.log('BasketController.initialize');
    },

    // backpropagate current basket entries into action state (rating, signal coloring, etc.)
    link_document: function(entry, number) {

        // why do we have to access the global object here?
        // maybe because of the event machinery which dispatches to us?
        var numbers = opsChooserApp.basketModel ? opsChooserApp.basketModel.get_numbers() : [];

        var checkbox_element = $('#chk-patent-number-' + number);
        var add_button_element = $('#add-patent-number-' + number);
        var remove_button_element = $('#remove-patent-number-' + number);
        var rating_widget = $('#rate-patent-number-' + number);
        var indicator_element = rating_widget.closest('.ops-collection-entry-heading');

        // number is not in basket, show "add" button
        if (!_(numbers).contains(number)) {
            checkbox_element && checkbox_element.prop('checked', false);
            add_button_element && add_button_element.show();
            remove_button_element && remove_button_element.hide();

            // clear rating widget
            rating_widget.raty('reload');

            // clear color indicators
            indicator_element.toggleClass('dismiss', false);
            indicator_element.toggleClass('score1', false);
            indicator_element.toggleClass('score2', false);
            indicator_element.toggleClass('score3', false);

        // number is already in basket, show "remove" button and propagate rating values
        } else {
            checkbox_element && checkbox_element.prop('checked', true);
            add_button_element && add_button_element.hide();
            remove_button_element && remove_button_element.show();

            // if we have a model, propagate "score" and "dismiss" values
            if (entry) {
                var score = entry.get('score');
                var dismiss = entry.get('dismiss');

                // a) to rating widget
                rating_widget.raty('score', score);
                rating_widget.raty('dismiss', dismiss);

                // b) to color indicator
                indicator_element.toggleClass('dismiss', Boolean(dismiss));
                indicator_element.toggleClass('score1', score == 1);
                indicator_element.toggleClass('score2', score == 2);
                indicator_element.toggleClass('score3', score == 3);

            }

        }

    },

});

// setup component
opsChooserApp.addInitializer(function(options) {

    this.basketController = new BasketController();

    // Special bootstrap handling for datasource=review:
    // This activates the review after both the application
    // and the basket signal readyness.
    this.listenTo(this, 'application:ready', function() {
        if (this.config.get('datasource') == 'review') {
            this.listenToOnce(this, 'basket:activated', function(basket) {
                $.when(basket.init_from_query()).then(function() {
                    basket.review();
                });
            });
        }
    });

});