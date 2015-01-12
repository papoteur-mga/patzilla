# -*- coding: utf-8 -*-
# (c) 2009 ***REMOVED***
# (c) 2015 Andreas Motl, Elmyra UG <andreas.motl@elmyra.de>
import nose.tools
from collections import OrderedDict
from elmyra.ip.util.numbers.common import split_patent_number


good = OrderedDict()
good['USRE039998E1']     = {'country': 'US', 'kind': 'E1', 'ext': '', 'number': 'RE039998'}
good['BR000PI0502229A']  = {'country': 'BR', 'kind': 'A',  'ext': '', 'number': '000PI0502229'}

bad = OrderedDict()
bad['WO2003EP8824']      = None
bad['IT19732A88']        = None
bad['JPHEI 3-53606']     = None


class TestNumberDecoding:

    def testDecodeOK(self):
        for number, expected, computed in self.generate(good):
            yield self.check_ok, number, expected, computed

    def testDecodeBAD(self):
        for number, expected, computed in self.generate(bad):
            yield self.check_ok, number, expected, computed

    def generate(self, data):
        for number, number_normalized_expect in data.iteritems():
            number_normalized_computed = split_patent_number(number)
            yield number, number_normalized_expect, number_normalized_computed

    def check_ok(self, number, expected, computed):
        assert computed == expected, "number: %s, expected: %s, computed: %s" % (number, expected, computed)

    #@nose.tools.raises(ValueError)
    #def check_fail(self, ipc_class):
    #    IpcDecoder(ipc_class['raw'])