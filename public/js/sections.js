const SECTIONS = {
  personal: {
    name: 'Personal Identity',
    icon: '\u{1F464}',
    fields: [
      { key: 'full_name', label: 'Full Legal Name', type: 'text' },
      { key: 'date_of_birth', label: 'Date of Birth', type: 'date' },
      { key: 'place_of_birth', label: 'Place of Birth', type: 'text' },
      { key: 'nationality', label: 'Nationality', type: 'text' },
      { key: 'national_id', label: 'National ID / SSN', type: 'text', sensitive: true },
      { key: 'passport_number', label: 'Passport Number', type: 'text', sensitive: true },
      { key: 'passport_expiry', label: 'Passport Expiry', type: 'date' },
      { key: 'drivers_license', label: "Driver's License Number", type: 'text', sensitive: true },
      { key: 'tax_id', label: 'Tax ID / PAN', type: 'text', sensitive: true },
      { key: 'mobile_phone', label: 'Mobile Phone', type: 'text' },
      { key: 'alternate_phone', label: 'Alternate Phone', type: 'text' },
      { key: 'home_phone', label: 'Home Phone', type: 'text' },
      { key: 'blood_group', label: 'Blood Group', type: 'text' },
      { key: 'address', label: 'Current Address', type: 'textarea' }
    ]
  },
  bank_accounts: {
    name: 'Bank Accounts',
    icon: '\u{1F3E6}',
    fields: [
      { key: 'bank_name', label: 'Bank Name', type: 'text' },
      { key: 'account_type', label: 'Account Type', type: 'select', options: ['Bank', 'Cash', 'Savings', 'Current / Checking', 'Fixed Deposit', 'Recurring Deposit', 'Joint Account', 'Other'] },
      { key: 'homebank_group', label: 'HomeBank Group', type: 'text' },
      { key: 'account_number', label: 'Account Number', type: 'text', sensitive: true },
      { key: 'ifsc_routing', label: 'IFSC / Routing / SWIFT', type: 'text' },
      { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'nominee', label: 'Nominee Name', type: 'text' },
      { key: 'balance_approx', label: 'Approximate Balance', type: 'text' },
      { key: 'online_url', label: 'Online Banking URL', type: 'text' },
      { key: 'username', label: 'Online Username', type: 'text' }
    ]
  },
  investments: {
    name: 'Investments',
    icon: '\u{1F4C8}',
    fields: [
      { key: 'institution', label: 'Institution / Platform', type: 'text' },
      { key: 'homebank_group', label: 'HomeBank Group', type: 'text' },
      { key: 'type', label: 'Type', type: 'select', options: ['Stocks', 'Mutual Funds', 'Bonds', 'ETFs', 'Cryptocurrency', 'Fixed Income', 'PPF / EPF', 'Other'] },
      { key: 'account_number', label: 'Account / Folio Number', type: 'text', sensitive: true },
      { key: 'value_approx', label: 'Approximate Value', type: 'text' },
      { key: 'nominee', label: 'Nominee Name', type: 'text' },
      { key: 'login_url', label: 'Platform URL', type: 'text' },
      { key: 'username', label: 'Username', type: 'text' }
    ]
  },
  retirement: {
    name: 'Retirement Accounts',
    icon: '\u{1F3D6}',
    fields: [
      { key: 'provider', label: 'Provider / Employer', type: 'text' },
      { key: 'homebank_group', label: 'HomeBank Group', type: 'text' },
      { key: 'type', label: 'Account Type', type: 'select', options: ['401(k)', 'IRA', 'Roth IRA', 'Pension', 'Provident Fund', 'EPF', 'NPS', 'Annuity', 'Other'] },
      { key: 'investment_type', label: 'Underlying Account / Investment Type', type: 'text' },
      { key: 'account_number', label: 'Account Number', type: 'text', sensitive: true },
      { key: 'value_approx', label: 'Approximate Value', type: 'text' },
      { key: 'beneficiary', label: 'Designated Beneficiary', type: 'text' },
      { key: 'login_url', label: 'Portal URL', type: 'text' }
    ]
  },
  insurance: {
    name: 'Insurance Policies',
    icon: '\u{1F6E1}',
    fields: [
      { key: 'provider', label: 'Insurance Company', type: 'text' },
      { key: 'type', label: 'Policy Type', type: 'select', options: ['Life Insurance', 'Term Life', 'Health', 'Auto', 'Home', 'Disability', 'Travel', 'Other'] },
      { key: 'policy_number', label: 'Policy Number', type: 'text', sensitive: true },
      { key: 'sum_assured', label: 'Sum Assured / Coverage', type: 'text' },
      { key: 'premium', label: 'Premium Amount', type: 'text' },
      { key: 'frequency', label: 'Premium Frequency', type: 'select', options: ['Monthly', 'Quarterly', 'Semi-Annual', 'Annual'] },
      { key: 'maturity_date', label: 'Maturity / Renewal Date', type: 'date' },
      { key: 'nominee', label: 'Nominee', type: 'text' },
      { key: 'agent_name', label: 'Agent Name', type: 'text' },
      { key: 'agent_phone', label: 'Agent Phone', type: 'text' }
    ]
  },
  real_estate: {
    name: 'Real Estate & Property',
    icon: '\u{1F3E0}',
    fields: [
      { key: 'homebank_group', label: 'HomeBank Group', type: 'text' },
      { key: 'type', label: 'Property Type', type: 'select', options: ['Residential', 'Commercial', 'Land', 'Agricultural', 'Rental', 'Other'] },
      { key: 'address', label: 'Property Address', type: 'textarea' },
      { key: 'ownership', label: 'Ownership', type: 'select', options: ['Sole Owner', 'Joint Owner', 'Through Company', 'Trust'] },
      { key: 'co_owners', label: 'Co-owners', type: 'text' },
      { key: 'purchase_value', label: 'Purchase Value', type: 'text' },
      { key: 'current_value', label: 'Current Value (est.)', type: 'text' },
      { key: 'deed_location', label: 'Where Deed Is Stored', type: 'text' },
      { key: 'mortgage_provider', label: 'Mortgage Provider', type: 'text' },
      { key: 'mortgage_account', label: 'Mortgage Account #', type: 'text' },
      { key: 'mortgage_balance', label: 'Outstanding Mortgage', type: 'text' }
    ]
  },
  debts: {
    name: 'Debts & Liabilities',
    icon: '\u{1F4B3}',
    fields: [
      { key: 'homebank_group', label: 'HomeBank Group', type: 'text' },
      { key: 'creditor', label: 'Creditor / Lender', type: 'text' },
      { key: 'type', label: 'Type', type: 'select', options: ['Mortgage', 'Personal Loan', 'Car Loan', 'Student Loan', 'Credit Card', 'Business Loan', 'Informal Loan', 'Other'] },
      { key: 'account_number', label: 'Account / Loan #', type: 'text', sensitive: true },
      { key: 'outstanding', label: 'Outstanding Amount', type: 'text' },
      { key: 'monthly_payment', label: 'Monthly Payment', type: 'text' },
      { key: 'interest_rate', label: 'Interest Rate', type: 'text' },
      { key: 'end_date', label: 'Loan End Date', type: 'date' },
      { key: 'collateral', label: 'Collateral / Security', type: 'text' }
    ]
  },
  digital: {
    name: 'Digital Accounts',
    icon: '\u{1F4BB}',
    fields: [
      { key: 'service', label: 'Service Name', type: 'text' },
      { key: 'type', label: 'Type', type: 'select', options: ['Email', 'Social Media', 'Cloud Storage', 'Subscription', 'Domain / Hosting', 'Crypto Exchange', 'Shopping', 'Utility', 'Other'] },
      { key: 'url', label: 'URL', type: 'text' },
      { key: 'username', label: 'Username / Email', type: 'text' },
      { key: 'password', label: 'Password', type: 'password', sensitive: true },
      { key: 'two_factor', label: '2FA Method & Backup Codes', type: 'textarea', sensitive: true },
      { key: 'recovery_email', label: 'Recovery Email / Phone', type: 'text' },
      { key: 'monthly_cost', label: 'Monthly Cost', type: 'text' }
    ]
  },
  vehicles: {
    name: 'Vehicles',
    icon: '\u{1F697}',
    fields: [
      { key: 'homebank_group', label: 'HomeBank Group', type: 'text' },
      { key: 'type', label: 'Vehicle Type', type: 'select', options: ['Car', 'Motorcycle', 'Truck', 'Boat', 'RV', 'Other'] },
      { key: 'make_model', label: 'Make & Model', type: 'text' },
      { key: 'year', label: 'Year', type: 'text' },
      { key: 'registration', label: 'Registration Number', type: 'text' },
      { key: 'vin', label: 'VIN / Chassis Number', type: 'text', sensitive: true },
      { key: 'current_value', label: 'Current Value (est.)', type: 'text' },
      { key: 'loan_provider', label: 'Loan Provider', type: 'text' },
      { key: 'loan_balance', label: 'Loan Balance', type: 'text' },
      { key: 'insurance_policy', label: 'Insurance Policy #', type: 'text' }
    ]
  },
  valuables: {
    name: 'Valuables & Collections',
    icon: '\u{1F48E}',
    fields: [
      { key: 'type', label: 'Type', type: 'select', options: ['Jewelry', 'Art', 'Collectibles', 'Antiques', 'Safe Deposit Box', 'Gold / Silver', 'Other'] },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'estimated_value', label: 'Estimated Value', type: 'text' },
      { key: 'proof', label: 'Proof of Ownership', type: 'text' }
    ]
  },
  contacts: {
    name: 'Important Contacts',
    icon: '\u{1F4DE}',
    fields: [
      { key: 'role', label: 'Role', type: 'select', options: ['Lawyer', 'Accountant / CA', 'Financial Advisor', 'Insurance Agent', 'Doctor', 'Employer', 'Business Partner', 'Trustee', 'Other'] },
      { key: 'name', label: 'Full Name', type: 'text' },
      { key: 'organization', label: 'Organization', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'address', label: 'Address', type: 'textarea' },
      { key: 'context', label: 'What They Handle', type: 'textarea' }
    ]
  },
  legal: {
    name: 'Legal Documents',
    icon: '\u{1F4DC}',
    fields: [
      { key: 'type', label: 'Document Type', type: 'select', options: ['Will', 'Trust', 'Power of Attorney', 'Advance Directive', 'Birth Certificate', 'Marriage Certificate', 'Divorce Decree', 'Business Registration', 'Other'] },
      { key: 'date', label: 'Document Date', type: 'date' },
      { key: 'stored_at', label: 'Where It Is Stored', type: 'text' },
      { key: 'lawyer_name', label: 'Lawyer / Notary Name', type: 'text' },
      { key: 'lawyer_phone', label: 'Lawyer / Notary Phone', type: 'text' },
      { key: 'details', label: 'Key Details', type: 'textarea' }
    ]
  },
  final_wishes: {
    name: 'Final Wishes',
    icon: '\u{1F54A}',
    fields: [
      { key: 'category', label: 'Category', type: 'select', options: ['Beneficiary Instructions', 'Funeral Arrangements', 'Burial / Cremation', 'Organ Donation', 'Memorial Preferences', 'Message to Family', 'Charitable Wishes', 'Pet Care', 'Other'] },
      { key: 'details', label: 'Details', type: 'textarea' },
      { key: 'contact_person', label: 'Contact Person', type: 'text' },
      { key: 'contact_phone', label: 'Contact Phone', type: 'text' }
    ]
  },
  secure_notes: {
    name: 'Secure Notes',
    icon: '\u{1F512}',
    // Keep the schema for existing records and old backups, without offering
    // this category in navigation, the dashboard or new-entry routes.
    retired: true,
    fields: [
      { key: 'content', label: 'Note Content', type: 'textarea' }
    ]
  },
  pet_care: {
    name: 'Pet Care',
    icon: '\u{1F43E}',
    fields: [
      { key: 'pet_name', label: 'Pet Name', type: 'text' },
      { key: 'species', label: 'Animal Type', type: 'select', options: ['Dog', 'Cat', 'Bird', 'Fish', 'Reptile', 'Small Mammal', 'Horse', 'Other'] },
      { key: 'breed', label: 'Breed / Description', type: 'text' },
      { key: 'date_of_birth', label: 'Date of Birth', type: 'date' },
      { key: 'microchip_number', label: 'Microchip / Identification Number', type: 'text' },
      { key: 'vet_name', label: 'Vet / Practice Name', type: 'text' },
      { key: 'vet_phone', label: 'Vet Phone', type: 'tel' },
      { key: 'vet_address', label: 'Vet Address', type: 'textarea' },
      { key: 'dietary_needs', label: 'Food, Feeding Schedule & Dietary Needs', type: 'textarea' },
      { key: 'medications', label: 'Medications & Medical Needs', type: 'textarea' },
      { key: 'care_instructions', label: 'Daily Routine & Care Instructions', type: 'textarea' },
      { key: 'preferred_carer', label: 'Preferred Carer', type: 'text' },
      { key: 'carer_phone', label: 'Carer Phone', type: 'tel' },
      { key: 'rehoming_plan', label: 'Rehoming Plan', type: 'textarea' }
    ]
  }
};
