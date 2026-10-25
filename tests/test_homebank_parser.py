"""Fixture-only tests; never add actual bank files to Git."""
import datetime as dt
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
MOD=Path(__file__).resolve().parent.parent/'server/homebank_parse.py'
spec=importlib.util.spec_from_file_location('hbparse',MOD)
hb=importlib.util.module_from_spec(spec); spec.loader.exec_module(hb)
SAMPLE='''<?xml version="1.0"?><homebank v="1.6">
<cur key="1" iso="ZAR"/>
<account key="1" type="1" name="Sample bank" curr="1" initial="100"/>
<account key="2" type="3" name="Historical property" curr="1" initial="200" flags="18"/>
<account key="3" type="7" name="Hidden savings" curr="1" initial="50" flags="16"/>
<ope date="739914" amount="35" account="1" st="2"/>
<ope date="739914" amount="-10" account="1" st="1"/>
<ope date="739914" amount="25" account="1" flags="32"/>
<ope date="739914" amount="300" account="1" st="3"/>
<ope date="739915" amount="40" account="1"/>
</homebank>'''
class HomebankParserTest(unittest.TestCase):
    def setUp(self):
        self.f=tempfile.NamedTemporaryFile('w',suffix='.xhb',delete=False)
        self.f.write(SAMPLE);self.f.close()
    def tearDown(self):os.unlink(self.f.name)
    def test_account_filters_and_balances(self):
        data=hb.parse(self.f.name,today=dt.date(2026,10,25))
        self.assertEqual(data['counts'],{'all':3,'closed':1,'excluded_open':1,'shown':1})
        a=data['accounts'][0];self.assertEqual(a['today'],125)
        self.assertEqual(a['future'],165)
        self.assertEqual(a['cleared'],125)
        self.assertEqual(a['reconciled'],135)
        self.assertEqual(a['transaction_count'],5)
    def test_does_not_modify_source(self):
        original=Path(self.f.name).read_bytes()
        hb.parse(self.f.name,today=dt.date(2026,10,25))
        self.assertEqual(original,Path(self.f.name).read_bytes())
    def test_invalid_file(self):
        Path(self.f.name).write_text('<bad/>')
        with self.assertRaises(ValueError): hb.parse(self.f.name)
if __name__=='__main__': unittest.main()
