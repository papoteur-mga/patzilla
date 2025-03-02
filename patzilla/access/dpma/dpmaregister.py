# -*- coding: utf-8 -*-
# (c) 2011-2022 Andreas Motl <andreas.motl@ip-tools.org>
import re
import sys
from datetime import date

import attr
import json
import time
import logging
import operator
import mechanicalsoup
from beaker.cache import cache_region
from munch import munchify
from docopt import docopt
from pprint import pformat
from jsonpointer import JsonPointer, JsonPointerException
from xml.etree.ElementTree import fromstring
from bs4 import BeautifulSoup
from collections import namedtuple, OrderedDict
from patzilla.access.dpma.util import dpma_file_number
from patzilla.boot.cache import configure_cache_backend
from patzilla.util.config import to_list
from patzilla.boot.logging import boot_logging
from patzilla.util.network.browser import regular_user_agent
from patzilla.util.xml.format import BadgerFishNoNamespace
from patzilla.version import __version__

logger = logging.getLogger(__name__)


class NoResults(Exception):
    pass


class UnknownFormat(Exception):
    pass


@attr.s
class Document(object):
    """An intermediary object holding information from accessing DPMAregister on the container level"""
    meta = attr.ib(default=None)
    url_html = attr.ib(default=None)
    url_pdf = attr.ib(default=None)
    response = attr.ib(default=None)

@attr.s
class ResultEntry(object):
    """An intermediary object holding information from accessing DPMAregister on the result level"""
    label = attr.ib(default=None)
    reference = attr.ib(default=None)


class DpmaRegisterAccess:
    """
    Screen scraper for DPMAregister "basic search" web interface
    https://register.dpma.de/DPMAregister/pat/basis?lang=en

    Alternative direct link, e.g.
    https://register.dpma.de/DPMAregister/pat/experte/autoRecherche/de?queryString=AKZ%3D2020131020184
    https://register.dpma.de/DPMAregister/pat/experte/autoRecherche/de?queryString=EPN%3D666666
    https://register.dpma.de/DPMAregister/pat/experte/autoRecherche/de?queryString=PN%3DWO2008034638

    Todo:
    - Improve response data chain
    - Enable searching for arbitrary expressions/fields, not just for document number
    - Use MongoDB database cache
    """

    hosturl = 'https://register.dpma.de/'
    baseurl = 'https://register.dpma.de/DPMAregister/pat/'

    def __init__(self):

        # Whether we already have a valid HTTP session with the remote server
        self.http_session_valid = False

        # PEP 476: verify HTTPS certificates by default (implemented from Python 2.7.9)
        # https://bugs.python.org/issue22417
        if sys.hexversion >= 0x02070900:
            import ssl
            ssl._create_default_https_context = ssl._create_unverified_context

        # https://mechanicalsoup.readthedocs.io/
        self.browser = mechanicalsoup.StatefulBrowser()

        # Set custom user agent header
        # self.browser.set_user_agent(regular_user_agent)

        self.searchurl = self.baseurl + 'basis'
        self.accessurl = self.baseurl + 'register:showalleverfahrenstabellen?AKZ={number}&lang={language}'
        self.pdfurl = self.baseurl + 'register/PAT_{number}_{today}?AKZ={number}&VIEW=pdf'

        self.reference_pattern = re.compile('.*\?AKZ=(.+?)&.*')

    def start_http_session(self):
        if not self.http_session_valid:
            # 1. Open search url to initialize HTTP session
            self.response = self.browser.open(self.searchurl + "?lang=en")
            self.http_session_valid = True

    @cache_region('search')
    def get_document_url(self, patent, language='en'):
        file_reference = self.resolve_file_reference(patent)
        url = self.accessurl.format(number=file_reference.reference, language=language)
        logger.info('Document URL for {} is {}'.format(patent, url))
        return url

    @cache_region('medium')
    def fetch(self, patent, language='en'):
        document_intermediary = self.search_and_fetch(patent, language)
        if document_intermediary:
            document = DpmaRegisterHtmlDocument.from_result_document(document_intermediary)
            return document

    @cache_region('medium')
    def fetch_st36xml(self, patent, language='en'):
        """
        Example:
        https://register.dpma.de/DPMAregister/pat/register?AKZ=196308771&VIEW=st36
        """

        # Fetch main HTML resource of document.
        result = self.search_and_fetch(patent, language)

        if not result:
            logger.warning('Could not find document {}'.format(patent))
            return

        # Parse link to ST.36 XML document from HTML.
        # <a class="button" target="_blank" href="./register?AKZ=196308771&amp;VIEW=st36" name="st36xml">ST-36 download</a>
        # <a class="button" target="_blank" href="./register?AKZ=196308771&amp;VIEW=st36">ST-36 download</a>
        soup = result.response.soup
        st36xml_anchor = \
            soup.find("a", {'name': 'st36xml'}) or \
            soup.find("a", {'href': re.compile('VIEW=st36$')})
        st36xml_href = st36xml_anchor['href']

        if st36xml_href.startswith('/'):
            st36xml_href = self.hosturl + st36xml_href
        elif st36xml_href.startswith('./'):
            st36xml_href = self.baseurl + st36xml_href

        # Download ST.36 XML document and return response body.
        return self.browser.open(st36xml_href)

    @cache_region('medium')
    def fetch_pdf(self, patent, language='en'):

        # Fetch main HTML resource of document
        result = self.search_and_fetch(patent, language)

        if not result:
            logger.warning('Could not find document {}'.format(patent))
            return

        # Follow link to PDF document and return response
        return self.browser.download_link('register/PAT_.*VIEW=pdf')

    def search_first(self, patent):

        # 1. Search patent reference
        results = self.search_patent_smart(patent)

        # 2. Acquire page with register information
        # Remark: This just uses the first search result
        # TODO: Review this logic
        if results:
            return results[0]

    def search_and_fetch(self, patent, language='en'):
        """
        search_entry = self.search_first(patent)
        if search_entry:
            return self.fetch_reference(search_entry)
        """
        file_reference = self.resolve_file_reference(patent)
        if file_reference:
            return self.fetch_reference(file_reference, language)

    def resolve_file_reference(self, patent):

        # Compute DPMA file number (Aktenzeichen) from DE publication/application number
        # by calculating the checksum of the document number.
        # This is a shortcut because we won't have to go through the search step.
        # It only works for DE applications, though.
        if patent.startswith('DE'):
            file_number = dpma_file_number(patent)
            result = ResultEntry(reference = file_number, label = patent)

        # For all other numbers, we have to kick off
        # a search request and scrape the response.
        else:
            result = self.search_first(patent)

        if result:
            logger.info('DPMA file number for {} is {}'.format(patent, result.reference))
        else:
            logger.warning('Could not resolve DPMA file number for {}'.format(patent))

        return result

    def search_patent_smart(self, patent):

        patent = patent.upper()

        # 1. search patent reference for direct download
        results = self.search_patent(patent)
        #print results

        # When multiple results are returned, apply some rules for picking the right one.
        # TODO: Revisit this logic. The best thing would be to extend the interface to return
        #       multiple results and then have the downstream code sort it out.
        if results and len(results) > 1:
            if patent.startswith('DE'):
                results = [result for result in results if not result.reference.startswith('E')]
            if patent.startswith('WO'):
                results = [result for result in results if result.label.startswith('PCT')]

        errmsg = None
        if not results:
            errmsg = "Search result for '%s' is empty" % (patent)
        elif len(results) >= 2:
            errmsg = "Search result for '%s' is ambiguous: count=%s, results=%s" % (patent, len(results), results)

        if errmsg:
            logger.warning(errmsg)
            #raise Exception(errmsg)

        return results

    def search_patent(self, patent):

        logger.info("Searching document(s), patent='%s'" % patent)

        # 1. Open search url to initialize HTTP session
        self.start_http_session()

        # 2017-12-18: The DPMA seems to have put a throttling machinery in place by
        # means of the "reg.check" cookie, e.g. "reg.check1239723693=-853246121".
        # Let's honor this by also throttling the client. Otherwise, the response
        # might contain a valid result list but has zero results.
        # time.sleep(0.75)

        # 2022-06-01: The DPMA seems to have increased throttling, so the wait time
        # has to be adjusted.
        time.sleep(1.0)

        if b"/TSPD" in self.response.content:
            raise ValueError("Site is protected by F5 Advanced WAF")

        # Debugging
        # self.dump_response(self.response, dump_metadata=True)
        # sys.exit()

        # 2. Send inquiry

        # Fill form fields
        # http://wwwsearch.sourceforge.net/ClientForm/
        self.browser.select_form(selector='form')

        # Aktenzeichen or publication number
        self.browser['akzPn'] = patent

        # Submit form
        response = self.browser.submit_selected()

        # Debugging
        # self.dump_response(response, dump_metadata=True)
        # sys.exit()

        # 3. Evaluate response

        # 2013-05-11: The DPMA changed the HTTP interface: Searching now jumps
        # directly to the result detail page if there's just a single result.
        # Honor this by parsing the file number (Aktenzeichen) from the
        # response HTML and making up a single result from that.
        if '/pat/register' in self.browser.get_url():
            reference_link = response.soup.find('a', {'href': self.reference_pattern})
            reference, label = self.parse_reference_link(reference_link, patent)
            entry = ResultEntry(reference = reference, label = None)
            return [entry]

        # Sanity checks
        if b"<span>0 result/s</span>" in response.content:
            msg = 'No search results for "{}"'.format(patent)
            logger.warning(msg)
            raise NoResults(msg)

        # 4. Parse result table
        #    When multiple results have been found, the page at
        #    `/DPMAregister/pat/trefferliste` enumerates them.
        results = []
        items = response.soup.findAll("div", {"class": "dpma-ansichtcontainer"})
        for item in items:
            link = item.find("a")
            reference, label = self.parse_reference_link(link, patent)
            entry = ResultEntry(reference=reference, label=label)
            results.append(entry)

        logger.info("Searching for %s yielded %s results" % (patent, len(results)))

        return results

    def parse_reference_link(self, link, patent):
        m = self.reference_pattern.match(link['href'])
        if m:
            reference = m.group(1)
        else:
            msg = "Could not parse document reference from link '%s' (patent='%s')" % (link, patent)
            logger.error(msg)
            raise Exception(msg)
        label = link.find(string=True)
        return reference, label

    def fetch_reference(self, result, language):
        """open document url and return html"""

        # 1. Open search url to initialize HTTP session
        self.start_http_session()

        url_html = self.accessurl.format(number=result.reference, language=language)
        url_pdf = self.pdfurl.format(number=result.reference, today=date.today().isoformat())
        logger.info('Accessing URL {}'.format(url_html))
        response = self.browser.open(url_html)
        return Document(meta=result, url_html=url_html, url_pdf=url_pdf, response=response)

    def dump_response(self, response, dump_metadata = False):
        """
        Dump response information: Body and optionally metadata (url and headers).
        """
        if dump_metadata:
            print('url:', response.url)
            print('headers:', response.headers)
        print(response.content)


class DpmaRegisterHtmlDocument(object):
    """
    Decode information from DPMAregister HTML response.
    """

    def __init__(self, identifier, html=None, url_html=None, url_pdf=None):

        self.identifier = identifier
        self.html = html
        self.url_html = url_html
        self.url_pdf = url_pdf

        self.biblio = None
        self.events = None

        # Link to local CSS file
        self.link_css = './assets/dpmabasis_d.css'

    @classmethod
    def from_result_document(cls, doc):
        return cls(doc.meta.reference, html=doc.response.content, url_html=doc.url_html, url_pdf=doc.url_pdf)

    def __str__(self):
        return str(self.identifier) + ':\n' + pformat(self.events)

    def html_compact(self):
        """
        Strip all HTML information just leaving the tables containing register information.

        TODO: insert link to original document, insert link to pdf
        <a shape="rect" class="button" target="_blank" href="register?AKZ=100068189&amp;VIEW=pdf">PDF-Download</a>
        """

        soup = BeautifulSoup(self.html, "lxml")

        soup_content = soup.find('table', {'id': 'verfahrensdaten_tabelle'})

        # remove some tags
        remove_stuff = [
            ('div', {'class': 'objektblaettern'}),
            ('a', {'class': 'button'}),
            ('br', {'clear': 'none'}),
            ('div', {'class': 'clearer'}),
            ('p', {'style': 'clear:both'}),
            ('div', {'class': 't-invisible'}),
            ('div', {'class': 'regauskunft'}),
            ('a', {'href': re.compile('^./register:hideverfahrenstabelle.*')}),
            ('a', {'class': 'hidden'}),
        ]
        [[tag.extract() for tag in soup_content.findAll(item[0], item[1])] for item in remove_stuff]

        # <a href="./PatSchrifteneinsicht
        # <a shape="rect" href="./register:sortVerfahrensUebersicht

        # manipulate some links
        for link in soup.findAll('a', {'href': re.compile('^./PatSchrifteneinsicht.*')}):
            link['href'] = DpmaRegisterAccess.baseurl + link['href']
            if link.img:
                link.img.extract()

        for link in soup.findAll('a', {'href': re.compile('^./register.*')}):
            if link.contents:
                link.replaceWith(link.contents[0])

        document_source_link = str(self.url_html)
        document_pdf_link = str(self.url_pdf)
        css_local_link = self.link_css

        # TODO: Fix link to PDF document. Example:
        #       https://register.dpma.de/DPMAregister/pat/register/PAT_E954800058_2022-06-02?AKZ=E954800058&VIEW=pdf
        tpl = """
<html>
    <head>
        <link type="text/css" rel="stylesheet" href="%(css_local_link)s"/>
        <style type="text/css"><!-- ins {background: #bfb} del{background: #fcc} ins,del {text-decoration: none} --></style>
    </head>
    <body id="body">
        <div id="sourcelinkbox" align="left" style="padding: 10px">
            Quelle:
            <a href="%(document_source_link)s" target="_blank">HTML</a>,
            <a href="%(document_pdf_link)s" target="_blank">PDF</a>
        </div>
        %(soup_content)s
    </body>
</html>
""".strip()

        # render
        html_stripped = tpl % locals()

        # fixup
        html_stripped = html_stripped.replace('Verfahrensansicht \xc2\xa0 \xc2\xa0', '')

        return html_stripped

    def asdict(self):
        self.parse_html()
        payload = OrderedDict()
        payload['biblio'] = self.biblio
        payload['events'] = self.events
        return payload

    def asjson(self):
        return json.dumps(self.asdict(), indent=2)

    def parse_html(self):
        """
        parse document results from html tables
        FIXME: unfinished!
        """
        soup = BeautifulSoup(self.html)
        soup_table_basicdata = soup.find("table")
        soup_table_legaldata = soup_table_basicdata.findNextSibling("table")

        self.biblio = self.soup_parse_table(soup_table_basicdata)
        self.events = self.soup_parse_table(soup_table_legaldata)

    def soup_parse_table(self, soup_table):

        # Represent a single cell when parsing the result table.
        Cell = namedtuple('Cell', ['name', 'value'])

        # Read whole table.
        table = []
        rows = soup_table.findAll('tr')
        for soup_data_row in rows:
            data_row = []
            for td in soup_data_row.findAll("td"):
                name = td["data-th"]
                value = td.getText()
                cell = Cell(name, value)
                data_row.append(cell)
            if data_row:
                table.append(data_row)

        return table


@attr.s
class DpmaRegisterXmlDocument(object):
    """
    Decode information from DPMAregister ST.36 XML document.
    """

    _xml = attr.ib()
    _data = attr.ib(default=None)

    application_reference = attr.ib(default=attr.Factory(list))
    publication_reference = attr.ib(default=attr.Factory(list))
    title = attr.ib(default=attr.Factory(dict))
    classifications = attr.ib(default=attr.Factory(dict))
    pct_or_regional_data = attr.ib(default=attr.Factory(dict))

    applicants = attr.ib(default=attr.Factory(list))
    inventors = attr.ib(default=attr.Factory(list))
    agents = attr.ib(default=attr.Factory(list))
    correspondents = attr.ib(default=attr.Factory(list))

    priority_claims = attr.ib(default=attr.Factory(list))
    designated_states = attr.ib(default=attr.Factory(list))
    references_cited = attr.ib(default=attr.Factory(list))
    office_specific_bibdata = attr.ib(default=attr.Factory(dict))
    events = attr.ib(default=attr.Factory(list))

    pointer_publication_reference = JsonPointer('/dpma-patent-document/bibliographic-data/publication-references/publication-reference')
    pointer_application_reference = JsonPointer('/dpma-patent-document/bibliographic-data/application-reference')
    pointer_title = JsonPointer('/dpma-patent-document/bibliographic-data/invention-title')
    pointer_classifications_ipcr = JsonPointer('/dpma-patent-document/bibliographic-data/classifications-ipcr/classification-ipcr')
    pointer_pct_or_regional_publishing_data = JsonPointer('/dpma-patent-document/bibliographic-data/pct-or-regional-publishing-data')
    pointer_pct_or_regional_filing_data = JsonPointer('/dpma-patent-document/bibliographic-data/pct-or-regional-filing-data')

    pointer_applicants = JsonPointer('/dpma-patent-document/bibliographic-data/parties/applicants/applicant')
    pointer_inventors = JsonPointer('/dpma-patent-document/bibliographic-data/parties/inventors/inventor')
    pointer_agents = JsonPointer('/dpma-patent-document/bibliographic-data/parties/agents/agent')
    pointer_correspondents = JsonPointer('/dpma-patent-document/bibliographic-data/parties/correspondence-address')

    pointer_priority_claims = JsonPointer('/dpma-patent-document/bibliographic-data/priority-claims/priority-claim')
    pointer_designated_states = JsonPointer('/dpma-patent-document/bibliographic-data/designation-of-states/designation-pct/regional/country')
    pointer_references_cited = JsonPointer('/dpma-patent-document/bibliographic-data/references-cited/citation/patcit')
    pointer_office_specific_bibdata = JsonPointer('/dpma-patent-document/bibliographic-data/office-specific-bib-data')
    pointer_events = JsonPointer('/dpma-patent-document/events/event-data')

    def decode_badgerfish(self):
        self._data = BadgerFishNoNamespace(xml_fromstring=False, dict_type=OrderedDict).data(fromstring(self._xml))
        return self

    def decode(self):

        # Convert from XML to data structure using the Badgerfish convention
        self.decode_badgerfish()

        # Document numbers
        self.application_reference = list(map(
            operator.itemgetter('document_id'),
            self.convert_list(self.query_data(self.pointer_application_reference))))

        self.publication_reference = list(map(
            operator.itemgetter('document_id'),
            self.convert_list(self.query_data(self.pointer_publication_reference))))

        # Classifications
        self.classifications['ipcr'] = self.convert_list(self.query_data(self.pointer_classifications_ipcr))

        # pct-or-regional-{publishing,filing}-data
        self.pct_or_regional_data = {
            'filing': self.convert_list(self.query_data(self.pointer_pct_or_regional_filing_data), 'document-id'),
            'publishing': self.convert_list(self.query_data(self.pointer_pct_or_regional_publishing_data), 'document-id'),
        }

        # Decode title
        title = self.pointer_title.resolve(self._data)
        self.title = {
            'lang': title['@lang'].lower(),
            'text': title['$'],
        }

        # Parties: Applicants, inventors, agents and correspondence address
        self.applicants = self.decode_parties(self.pointer_applicants)
        self.inventors = self.decode_parties(self.pointer_inventors)
        self.agents = self.decode_parties(self.pointer_agents)
        self.correspondents = self.decode_parties(self.pointer_correspondents)

        # Priority claims
        self.priority_claims = self.convert_list(self.query_data(self.pointer_priority_claims))

        # Designated states
        self.designated_states = self.convert_list(self.query_data(self.pointer_designated_states))

        # Citations
        self.references_cited = list(map(
            operator.attrgetter('document_id.doc_number'),
            munchify(self.convert_list(self.query_data(self.pointer_references_cited)))))

        # office-specific-bib-data
        self.office_specific_bibdata = self.convert_dict(self.query_data(self.pointer_office_specific_bibdata))

        # Decode list of events
        events = self.convert_list(self.query_data(self.pointer_events))
        self.events = sorted(events, key=operator.itemgetter('date_of_procedural_status'))

        return self

    def query_data(self, pointer):
        try:
            return pointer.resolve(self._data)
        except JsonPointerException:
            return

    @classmethod
    def convert_list(cls, things_raw, nested_element='$'):
        """Decode list of things"""
        things = []
        for thing in to_list(things_raw):
            if not thing: continue
            if nested_element in thing and len(list(thing.keys())) == 1:
                thing = thing[nested_element]
            if isinstance(thing, dict):
                thing = cls.convert_dict(thing)
            things.append(thing)
        return things

    @classmethod
    def convert_dict(cls, data):
        """Decode data thing"""

        # Sanity checks
        if not data:
            return {}

        newdata = OrderedDict()
        for key, value in list(data.items()):

            # Decode nested text or recurse
            if '$' in value:
                value = value['$']
            elif isinstance(value, dict):
                value = cls.convert_dict(value)

            # We want to have keys which are conveniently accessible as object attributes
            key = key.replace('-', '_')

            # Assign value
            newdata[key] = value

        return newdata

    def asdict(self):
        """Return dictionary of public instance attributes"""
        return attr.asdict(self,
            dict_factory=OrderedDict,
            filter=lambda attr, value: not attr.name.startswith('_'))

    def decode_parties(self, pointer):
        """
        ST.36: Decode list of applicants, inventors or agents.
        See also https://github.com/Patent2net/P2N/blob/develop/p2n/ops/decoder.py#L535
        """

        try:
            nodes = to_list(pointer.resolve(self._data))
        except JsonPointerException:
            return []

        entries = []
        for party in nodes:

            addressbook = party['addressbook']

            entry = OrderedDict()
            entry['name'] = addressbook['name']['$']
            entry['text'] = addressbook['text']['$']
            entry['country'] = addressbook['address']['country']['$']
            address = []
            for index in range(1, 7):
                fieldname = 'address-{}'.format(index)
                try:
                    value = addressbook['address'][fieldname]['$']
                    address.append(value)
                except KeyError:
                    pass

            entry['address'] = address

            entries.append(entry)

        return entries


APP_NAME = 'dpmaregister'

def run():
    """
    Usage:
      {program} fetch <document-number> [--format=<format>]
      {program} --version
      {program} (-h | --help)

    Options:
      <document-number>         Document number to access
      --format=<format>         Format for acquisition and output [default: xml]
                                Use one of xml, json, json-raw, html, html-compact, pdf, url

    Miscellaneous options:
      --debug                   Enable debug messages
      --version                 Show version information
      -h --help                 Show this screen

    Examples:

      # Fetch register information for WO2007037298 and output in ST.36 XML format
      dpmaregister fetch WO2007037298

      # Fetch register information for DE19630877 and output in JSON format
      dpmaregister fetch WO2007037298 --format=json

      # Fetch register information for WO2007037298 and output in compact HTML format
      dpmaregister fetch WO2007037298 --format=html-compact

    """

    # Use generic commandline options schema and amend with current program name
    commandline_schema = run.__doc__.format(program=APP_NAME)

    # Read commandline options
    options = docopt(commandline_schema, version=APP_NAME + ' ' + __version__)

    # Start logging subsystem
    boot_logging(options)

    # Debugging
    #print('options: {}'.format(options))

    if options['fetch']:
        document_number = options['<document-number>']
        output_format = options['--format']
        try:
            payload = access_register(document_number, output_format, 'en')
            print(payload)
        except NoResults as ex:
            logger.warning("No results for document {}".format(document_number))
            sys.exit(1)


def access_register(document_number, output_format, language='en'):

    register = DpmaRegisterAccess()

    if output_format == 'xml':
        response = register.fetch_st36xml(document_number, language)
        payload = response.content

    elif output_format == 'json-raw':
        response = register.fetch_st36xml(document_number, language)
        document = DpmaRegisterXmlDocument(response.content).decode_badgerfish()
        payload = json.dumps(document._data, indent=4)

    elif output_format == 'json':
        response = register.fetch_st36xml(document_number, language)
        document = DpmaRegisterXmlDocument(response.content).decode()
        payload = json.dumps(document.asdict(), indent=4)

    elif output_format == 'html':
        document = register.fetch(document_number, language)
        payload = document.html

    elif output_format == 'html-compact':
        document = register.fetch(document_number, language)
        if not document:
            raise NoResults("No result for document {}".format(document_number))
        payload = document.html_compact()

    elif output_format == 'pdf':
        response = register.fetch_pdf(document_number, language)
        payload = response.content

    elif output_format == 'url':
        payload = register.get_document_url(document_number, language)

    else:
        raise UnknownFormat('Unknown value for "format" parameter: {}'.format(output_format))

    return payload


def display_document(document):
    if not document:
        raise KeyError("No response or empty document")

    logger.info("Type:       %s", type(document))
    logger.info("Identifier: %s", document.identifier)
    logger.info("URL HTML:   %s", document.url_html)
    logger.info("URL PDF:   %s", document.url_pdf)
    print(document.html_compact())
    #print(document.asdict())
    print(document.asjson())


if __name__ == '__main__':
    """
    Workbench program.

    Synopsis::

        python -m patzilla.access.dpma.dpmaregister
    """

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)

    configure_cache_backend("filesystem")

    register = DpmaRegisterAccess()

    #document = register.fetch('10001499.2')     # Has two results, pick the first one, not prefixed with `E`.
    #document = register.fetch('DE3831719')      # Has two results, pick `P 38 31 719.2`, the second one.
    #document = register.fetch('WO2007037298')   # Worked with DPINFO only?
    #document = register.fetch('WO2008034638')   # Has two results, pick `50 2007 015 885.2`, the first one.
    #document = register.fetch('DE102006006014') # Has just one result, directly redirects to detail page.

    #document = register.fetch('DE19630877')
    #document = register.fetch('DE102012009645')
    document = register.fetch('EP666666')

    display_document(document)

    #print register.get_document_url('10001499.2')
    #print register.get_document_url('DE10001499.2')
    #print register.get_document_url('DE10001499')
    #print register.get_document_url('DE102012009645')
    #print register.get_document_url('EP666666')

    #response = register.fetch_st36xml('DE10001499')
    #response = register.fetch_st36xml('EP666666')
    #response = register.fetch_st36xml('10001499.2')
    #response = register.fetch_st36xml('DE19630877')

    #response = register.fetch_pdf('10001499.2')
    #response = register.fetch_pdf('DE10001499')
    #print(response.content)
