const PRODUCT_TYPES = [
  'forward contract', 'fx swap', 'flexi forward', 'window forward',
  'bonus forward', 'enhanced forward', 'smart forward',
  'dual currency investment', 'foreign currency account',
  'foreign currency term deposit', 'term deposit',
  'business loan', 'agri loan', 'commercial loan',
  'interest rate swap', 'interest rate cap', 'interest rate collar',
  'option', 'put option', 'call option',
  'line of credit', 'overdraft', 'bill facility',
];

const FINANCIAL_CONCEPTS = [
  'margin call', 'settlement', 'early termination', 'rollover',
  'mark to market', 'credit risk', 'exchange rate risk', 'interest rate risk',
  'counterparty risk', 'liquidity risk', 'operational risk',
  'collateral', 'security', 'guarantee', 'indemnity',
  'hedging', 'speculation', 'netting', 'novation',
  'cooling off', 'disclosure', 'product information statement',
  'product disclosure statement', 'financial services guide',
  'dispute resolution', 'complaints', 'privacy',
  'fees and charges', 'break costs', 'establishment fee',
  'minimum balance', 'maturity date', 'expiry date',
  'notional amount', 'principal amount', 'face value',
  'spot rate', 'forward rate', 'strike price', 'premium',
];

const BRANDS = {
  'wbc': 'Westpac',
  'bom': 'Bank of Melbourne',
  'sgb': 'St.George Bank',
  'bsa': 'BankSA',
};

const CATEGORIES = {
  'fx': 'Foreign Exchange',
  'irrm': 'Interest Rate Risk Management',
  'deps': 'Deposits',
  'loans': 'Loans',
};

module.exports = { PRODUCT_TYPES, FINANCIAL_CONCEPTS, BRANDS, CATEGORIES };
