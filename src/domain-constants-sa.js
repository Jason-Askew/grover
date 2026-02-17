// Services Australia domain entities

const PAYMENT_TYPES = [
  'age pension', 'disability support pension', 'carer payment',
  'parenting payment', 'jobseeker payment', 'youth allowance',
  'austudy', 'abstudy', 'newstart allowance', 'sickness allowance',
  'special benefit', 'crisis payment', 'family tax benefit',
  'double orphan pension', 'stillborn baby payment',
  'pension supplement', 'pension bonus', 'pensioner education supplement',
  'farm household allowance', 'status resolution support services',
  'carer allowance', 'carer adjustment payment',
  'mobility allowance', 'pharmaceutical allowance',
  'telephone allowance', 'utilities allowance',
  'remote area allowance', 'rent assistance',
  'education entry payment', 'advance payment',
  'essential medical equipment payment', 'continence aids payment scheme',
  'child disability assistance payment', 'newborn supplement',
  'newborn upfront payment', 'income support payment',
  'fares allowance', 'abstudy fares allowance',
  'child dental benefits schedule',
  // Child Support
  'child support', 'child support assessment', 'child support payment',
  // Parental leave & families
  'parental leave pay', 'dad and partner pay', 'child care subsidy',
  'additional child care subsidy', 'stillborn baby payment',
  // Students
  'student start-up loan', 'relocation scholarship',
  // Medicare
  'medicare', 'medicare card', 'medicare safety net',
  'medicare benefits schedule', 'bulk billing',
  'private health insurance rebate', 'ambulance cover',
  // Disability
  'national disability insurance scheme', 'ndis',
];

const GOVERNMENT_CONCEPTS = [
  'income test', 'assets test', 'means test',
  'waiting period', 'liquid assets waiting period',
  'newly arrived resident waiting period',
  'ordinary waiting period', 'seasonal work preclusion period',
  'compensation preclusion period',
  'residency requirements', 'australian resident',
  'qualifying age', 'pension age',
  'portability', 'proportional rate',
  'work capacity', 'continuing inability to work',
  'impairment tables', 'medical evidence',
  'concession card', 'pensioner concession card', 'health care card',
  'pharmaceutical benefits scheme', 'medicare safety net',
  'mutual obligation requirements', 'job plan',
  'activity test', 'participation requirements',
  'tax file number', 'proof of identity',
  'relationship status', 'member of a couple',
  'dependent child', 'family actual means test',
  'adjusted taxable income', 'maintenance income test',
  'taper rate', 'free area', 'disqualifying limit',
  'deeming', 'deemed income', 'financial assets',
  'principal home', 'exempt assets',
  'bereavement payment', 'lump sum bereavement payment',
  'nominee', 'correspondence nominee', 'payment nominee',
  // myGov & digital
  'mygov', 'digital identity', 'linking services',
  // Child support concepts
  'child support formula', 'care percentage', 'fixed annual rate',
  'minimum annual rate', 'child support period', 'taxable income',
  // Aged care
  'home care package', 'residential aged care', 'aged care assessment',
  'means tested care fee', 'basic daily fee', 'accommodation payment',
  'respite care', 'commonwealth home support programme',
  // Employment
  'workforce australia', 'working credit', 'employment income',
  'income bank', 'reporting requirements',
  // Families
  'immunisation requirements', 'no jab no pay',
  // Reciprocal agreements
  'reciprocal health care agreement', 'international social security agreement',
];

const SA_BRANDS = {
  'centrelink': 'Centrelink',
  'medicare': 'Medicare',
  'child-support': 'Child Support',
  'mygov': 'myGov',
};

const SA_CATEGORIES = {
  'payments': 'Payments',
  'pensions': 'Pensions',
  'allowances': 'Allowances',
  'documents': 'Documents',
  'general': 'General Information',
  'centrelink': 'Centrelink',
  'medicare': 'Medicare',
  'employment': 'Employment',
  'concessions': 'Concessions',
  'aged-care': 'Aged Care',
  'child-support': 'Child Support',
  'mygov': 'myGov & Digital',
  'childcare': 'Child Care',
  'families': 'Families',
  'students': 'Students',
  'disability': 'Disability',
  'crisis': 'Crisis & Bereavement',
  'indigenous': 'Indigenous Australians',
  'migrants': 'Migrants & Refugees',
  'veterans': 'Veterans',
};

module.exports = { PAYMENT_TYPES, GOVERNMENT_CONCEPTS, SA_BRANDS, SA_CATEGORIES };
