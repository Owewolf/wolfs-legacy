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
    def test_source_account_metadata_and_schema_version(self):
        Path(self.f.name).write_text('''<homebank v="1.6">
        <account key="1" name="Fixture account" bankname="Fixture Bank"
          number="001234567890" website="https://bank.example.test/"/>
        <account key="2" name="Fixture legacy" bankname="(null)" number=""/>
        </homebank>''')
        data=hb.parse(self.f.name,today=dt.date(2026,10,25))
        self.assertEqual(data['snapshot_schema_version'],3)
        account,legacy=data['accounts']
        self.assertEqual(account['bank_name'],'Fixture Bank')
        self.assertEqual(account['account_number'],'001234567890')
        self.assertEqual(account['website'],'https://bank.example.test/')
        for field in ('bank_name','account_number','website'):
            self.assertIsNone(legacy[field])
        # An account institution is not an asset-to-loan association.
        self.assertNotIn('loan_provider',account)
        self.assertNotIn('loan_balance',account)
    def test_account_groups_are_resolved_by_source_id_and_are_not_transaction_categories(self):
        Path(self.f.name).write_text('''<homebank v="1.6">
        <grp key="9" name="Retirement &amp; Pension"/>
        <grp key="3" name="Vehicle Assets"/>
        <cat key="9" name="Groceries"/>
        <account key="1" type="3" name="Fixture pension" grp="9"
          bankname="Fixture Provider" number="000123" initial="100"/>
        <account key="2" type="3" name="Fixture vehicle" grp="3" initial="200"/>
        <ope date="739914" amount="25" account="1" category="3" st="2"/>
        </homebank>''')
        data=hb.parse(self.f.name,today=dt.date(2026,10,25))
        accounts={account['id']:account for account in data['accounts']}
        self.assertEqual(accounts[1]['group_id'],9)
        self.assertEqual(accounts[1]['group_name'],'Retirement & Pension')
        self.assertEqual(accounts[2]['group_id'],3)
        self.assertEqual(accounts[2]['group_name'],'Vehicle Assets')
        self.assertEqual(accounts[1]['bank_name'],'Fixture Provider')
        self.assertEqual(accounts[1]['account_number'],'000123')
        self.assertEqual(accounts[1]['type_id'],3)
        self.assertEqual(accounts[1]['today'],125)
        self.assertEqual(accounts[1]['reconciled'],125)
        self.assertEqual(accounts[1]['transactions'][0]['category_id'],3)
    def test_missing_blank_and_unknown_account_groups_stay_unclassified(self):
        Path(self.f.name).write_text('''<homebank v="1.6">
        <grp key="1" name="   "/><grp key="2" name="(null)"/>
        <grp key="3"/>
        <account key="1" name="Missing"/>
        <account key="2" name="Zero" grp="0"/>
        <account key="3" name="Blank" grp="1"/>
        <account key="4" name="Legacy null" grp="2"/>
        <account key="5" name="Unnamed" grp="3"/>
        <account key="6" name="Unknown" grp="99"/>
        <account key="7" name="Invalid" grp="not-an-id"/>
        <account key="8" name="Negative" grp="-1"/>
        </homebank>''')
        accounts={account['id']:account for account in hb.parse(self.f.name)['accounts']}
        for account in accounts.values():
            self.assertIsNone(account['group_name'])
        for account_id in (1,2,7,8):
            self.assertIsNone(accounts[account_id]['group_id'])
        self.assertEqual(accounts[6]['group_id'],99)
    def test_ambiguous_or_invalid_group_definitions_are_rejected(self):
        for definitions in (
            '<grp key="1" name="Vehicles"/><grp key="1" name="Retirement"/>',
            '<grp name="Retirement"/>',
            '<grp key="invalid" name="Retirement"/>',
            '<grp key="0" name="Retirement"/>',
        ):
            with self.subTest(definitions=definitions):
                Path(self.f.name).write_text('<homebank v="1.6">'+definitions+
                    '<account key="1" type="3" grp="1"/></homebank>')
                with self.assertRaisesRegex(ValueError,'account group key'):
                    hb.parse(self.f.name)
    def test_invalid_file(self):
        Path(self.f.name).write_text('<bad/>')
        with self.assertRaises(ValueError): hb.parse(self.f.name)
if __name__=='__main__': unittest.main()
