#!/usr/bin/env python3
"""Read-only HomeBank XHB parser. Produces normalized account snapshots on stdout.
No writes to HomeBank files. Date values are Gregorian ordinals (GDate Julian).
"""
import datetime as dt
import json
import os
import sys
import xml.etree.ElementTree as ET

TYPES = {0: 'Uncategorised', 1: 'Bank', 2: 'Cash', 3: 'Asset', 4: 'Credit card',
         5: 'Liability', 6: 'Checking', 7: 'Savings'}
CLOSED = 1 << 1
NO_SUMMARY = 1 << 4
REMINDER = 1 << 5
PENDING_IMPORT = (1 << 9) | (1 << 10)

def integer(value, default=0):
    try:
        return int(value)
    except (ValueError, TypeError):
        return default

def decimal(value):
    try:
        v = float(value)
        return v if abs(v) < 1e20 else 0.0
    except (ValueError, TypeError):
        return 0.0

def iso_date(value):
    num = integer(value)
    try:
        return dt.date.fromordinal(num).isoformat() if num else None
    except ValueError:
        return None

def parse(filepath, today=None):
    if os.stat(filepath).st_size > 50 * 1024 * 1024:
        raise ValueError('HomeBank file exceeds 50 MB safety limit')
    if today is None:
        today = dt.date.today()
    # XML entities, external DTDs and unrelated formats are not expected in XHB.
    with open(filepath, 'rb') as f:
        head = f.read(1024)
        if b'<!DOCTYPE' in head.upper() or b'<!ENTITY' in head.upper():
            raise ValueError('DTD/entities are not supported')
    root = ET.parse(filepath).getroot()
    if root.tag != 'homebank' or not root.get('v'):
        raise ValueError('Not a valid HomeBank .xhb file')
    currencies = {integer(x.get('key')): x.get('iso', 'ZAR') for x in root.findall('cur')}
    accounts = {}
    for a in root.findall('account'):
        key = integer(a.get('key'), -1)
        if key <= 0 or key in accounts:
            raise ValueError('Invalid or duplicated HomeBank account key')
        flags = integer(a.get('flags'))
        initial = decimal(a.get('initial'))
        accounts[key] = {
            'id': key, 'name': a.get('name', ''), 'type_id': integer(a.get('type')),
            'type': TYPES.get(integer(a.get('type')), 'Other'),
            'currency': currencies.get(integer(a.get('curr')), 'ZAR'),
            'closed': bool(flags & CLOSED), 'excluded_from_summary': bool(flags & NO_SUMMARY),
            'flags': flags, 'initial': initial,
            'reconciled': initial, 'cleared': initial, 'today': initial, 'future': initial,
            'last_transaction': None, 'transaction_count': 0, 'transactions': [],
        }
    today_ord = today.toordinal()
    for txn in root.findall('ope'):
        acc = accounts.get(integer(txn.get('account'), -1))
        if acc is None:
            continue
        acc['transaction_count'] += 1
        dateordinal = integer(txn.get('date'))
        transdate = iso_date(txn.get('date'))
        if transdate and (acc['last_transaction'] is None or transdate > acc['last_transaction']):
            acc['last_transaction'] = transdate
        flags = integer(txn.get('flags'))
        status = integer(txn.get('st'))
        amount = decimal(txn.get('amount'))
        balanceable = not (flags & (REMINDER | PENDING_IMPORT)) and status != 3
        if balanceable:
            acc['future'] += amount
            if dateordinal <= today_ord: acc['today'] += amount
            if status in (1, 2): acc['cleared'] += amount
            if status == 2: acc['reconciled'] += amount
        acc['transactions'].append({
            'date': transdate, 'amount': round(amount, 2), 'status': status,
            'memo': txn.get('wording', ''), 'payee_id': integer(txn.get('payee')),
            'category_id': integer(txn.get('category')), 'transfer': bool(flags & (1 << 3)),
            'balanceable': balanceable,
        })
    for acc in accounts.values():
        for k in ('initial', 'reconciled', 'cleared', 'today', 'future'):
            acc[k] = round(acc[k], 2)
        acc['transactions'].sort(key=lambda t: t['date'] or '', reverse=True)
        acc['transactions'] = acc['transactions'][:100]  # explicitly labelled latest 100 in UI
    results = sorted(accounts.values(), key=lambda a: (a['type_id'], a['name'].casefold()))
    return {'format_version': root.get('v'), 'exported_date': str(today),
            'accounts': results, 'total_transactions': len(root.findall('ope')),
            'counts': {'all': len(results), 'closed': sum(a['closed'] for a in results),
                       'excluded_open': sum(a['excluded_from_summary'] and not a['closed'] for a in results),
                       'shown': sum(not a['closed'] and not a['excluded_from_summary'] for a in results)}}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Expected a single .xhb file path')
        print(json.dumps(parse(sys.argv[1]), separators=(',', ':'), ensure_ascii=False))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
