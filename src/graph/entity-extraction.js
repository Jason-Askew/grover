const { PRODUCT_TYPES, FINANCIAL_CONCEPTS, BRANDS, CATEGORIES } = require('../domain-constants');
const { PAYMENT_TYPES, GOVERNMENT_CONCEPTS, SA_BRANDS, SA_CATEGORIES } = require('../domain-constants-sa');

function compilePatterns(terms) {
  return terms.map(t => ({
    term: t,
    pattern: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  }));
}

const DOMAINS = {
  Westpac: {
    products: compilePatterns(PRODUCT_TYPES),
    concepts: compilePatterns(FINANCIAL_CONCEPTS),
    brands: BRANDS,
    categories: CATEGORIES,
  },
  ServicesAustralia: {
    products: compilePatterns(PAYMENT_TYPES),
    concepts: compilePatterns(GOVERNMENT_CONCEPTS),
    brands: SA_BRANDS,
    categories: SA_CATEGORIES,
  },
};

function extractEntities(text, domain = 'Westpac') {
  const entities = new Set();
  const d = DOMAINS[domain] || DOMAINS.Westpac;

  for (const { term, pattern } of d.products) {
    if (pattern.test(text)) entities.add(`product:${term}`);
  }
  for (const { term, pattern } of d.concepts) {
    if (pattern.test(text)) entities.add(`concept:${term}`);
  }

  return [...entities];
}

// ── Form code patterns (two-letter prefix + digits, or mod-*) ──
const FORM_CODE_RE = /^(fa|mo|pb|sa|ss|su|cs|db|hw|im|ip|ci|ma|ms|si|sy)\d/i;
const MOD_FORM_RE = /^mod-/i;

// ── Known language basenames (without .md extension) ──
const LANGUAGE_NAMES = new Set([
  'afaan-oromoo','amharic','anindilyakwa','arabic','assyrian','bembe','bengali',
  'bislama','bosnian','burarra','burmese','chaldean','chin-haka','chinese',
  'croatian','czech','danish','dari','dinka','djambarrpuyngu','dutch',
  'eastern-arrernte','eastside-kriol','estonian','falam-chin','fijian','finnish',
  'french','german','gilbertese','greek','hazaragi','hindi','hungarian',
  'indonesian','italian','japanese','karen','khmer','kimberley-kriol',
  'kinyarwanda','kirundi','korean','kunwinjku','kurdish-kurmanji','kurdish-sorani',
  'lao','latvian','macedonian','malay','maltese','nauruan','nepali','norwegian',
  'pashto','persian-farsi','pitjantjatjara','polish','portuguese','punjabi',
  'rarotongan','rohingya','russian','samoan','serbian','sinhalese','slovak',
  'slovene','solomon-islands-pidgin','somali','spanish','swahili','swedish',
  'tagalog','tamil','tedim-chin','tetum','thai','tibetan','tigrinya','tiwi',
  'tok-pisin','tongan','turkish','tuvaluan','ukrainian','urdu','vietnamese',
  'warlpiri','western-arrernte','yumplatok',
]);

// ── Medical condition patterns (PBS pharmaceutical benefits pages) ──
const MEDICAL_RE = /arthritis|spondylitis|cancer|carcinoma|leukaemia|lymphoma|myeloma|tumour|syndrome|disease|deficiency|fibrosis|anaemia|sclerosis|psoriasis|colitis|uveitis|hypertension|amyloidosis|cholestasis|haemoglobinuria|thrombocytopenic|angioedema|uraemic|narcolepsy|atrophy|acromegaly|hidradenitis|neuroblastoma|pouchitis|rhinosinusitis|retinopathy|oedema|neovascularisation|polycythemia|hyperoxaluria|ossificans|hypophosphataemia|opioid-treatment|toxicity-and-severity|cardiomyopathy|occlusion|arteritis|neurofibromatosis|neuromyelitis|asthma|urticaria|erythematosus|lupus/i;

// ── Keyword rules: ordered SPECIFIC → GENERAL, first match wins ──
// Rules match anywhere in the filename (no ^ anchors unless needed)
const FILENAME_CATEGORY_RULES = [
  // ── Child support (before generic "child") ──
  { pattern: /child.support|child.maintenance|spousal.support/i, category: 'child-support' },

  // ── Child care (before generic "child") ──
  { pattern: /child.care|childcare|family.day.care|child.wellbeing.subsidy/i, category: 'childcare' },

  // ── Income management / BasicsCard (before generic "income") ──
  { pattern: /income.management|basicscard|smartcard|enhanced.income.management/i, category: 'income-management' },

  // ── Health professionals / MBS / HPOS / providers (before generic "health") ──
  { pattern: /mbs-|hpos|provider.number|prescriber|practitioner|billing.rule|billing.code|allied.health|care.plan|telehealth|chronic.condition|eating.disorder|mental.health.(treatment|services)|for.your.patients|patient.details|find.patient|medical.practitioner|medical.intern|medical.services|practice.incentiv|practice.admin|practice.software|claim.processing|rejected.claims|check.mbs|submit.mbs|gp.chronic|prepare.gpccmp|review.eating.disorder|dispensing.highly|prescribing.highly|prescription.shopping|register.individual.practitioner|specialist.and.consultant|neurodevelopmental|clarifying.prescribers|referrals.and.requests|insurance.accreditation|childrens.health.services|systems.and.services.for.practitioners|connect.to.online.claiming|general.practice.training|web.services.for.digital.health|national.authentication.service|pki.policy|software.vendors|individual.practitioners|register.for.eclipse|register.for.healthcare|link.your.healthcare|who.can.use.find.patient|provider.digital.access|health.professional|health.service.provider|patient.care|opa.system/i, category: 'health-professionals' },

  // ── Medicare / health system ──
  { pattern: /medicare|bulk.billing|pbs-|pharmaceutical.benefit|immunisation|immunis|child.dental.benefit|my.health.record|reciprocal.health.care|health.insurance.rebate|covid.19|medicines.count|organ.and.tissue|medical.costs|medical.equipment|medical.certificate|medical.exemption|continence.aids|find.doctor|health.check|health.care.assistance|private.health.insurance|childrens.health/i, category: 'medicare' },

  // ── Aged care ──
  { pattern: /aged.care|^ac\d|home.care|residential.care|transition.care|respite.care|approved.care.org|caring.for.elderly|ageing|elder.health|claim.residential.care|register.*care.recipient|manage.home.care|finalise.transition.care|support.home.invoicing|historical.care.data/i, category: 'aged-care' },

  // ── Disability ──
  { pattern: /disability|ndis|impairment|reduced.capacity.to.work|dsp\b/i, category: 'disability' },

  // ── Veterans ──
  { pattern: /veteran|dva\b/i, category: 'veterans' },

  // ── Indigenous ──
  { pattern: /indigenous|aboriginal|torres.strait|youpla/i, category: 'indigenous' },

  // ── Migrants ──
  { pattern: /migrat|refugee|moving.to.australia|ukrainian.nationals|settlement.distribution|newly.arrived|residence.descriptions|residence.rules/i, category: 'migrants' },

  // ── Students / education ──
  { pattern: /abstudy|austudy|youth.allowance|student|tertiary.access|higher.education|education.entry|approved.courses|relocation.scholarship|isolated.children|leaving.secondary|starting.primary|starting.secondary|starting.study|school.years|school$|education$|education.and.training|pensioner.education.supplement|early.education|retraining|distance.*education|doing.higher.education|ending.higher.education|moving.for.study|online.review.study|away.from.base/i, category: 'students' },

  // ── Families / parenting / babies / FDV ──
  { pattern: /family.tax.benefit|child.care.subsidy|parental.leave|parenting.payment|newborn|having.baby|before.birth|baby.grows|baby.arrives|single.income.family|separated.parent|guide.for.newly.separated|foster.carer|grandparent.carer|kinship.carer|changing.your.child|family.assistance|parent.pathways|raising.kids|register.birth|pre.birth.claim|family.and.domestic|family.organisations|growing.up|family.income.estimate|childhood|child.health|child.turns|changing.your.childs|stillborn|teenage.years|tell.us.about.*child|hours.subsidised.child|resources.about.child.care|relationship.changes|relationship.status|getting.together|breaking.up|separating|making.your.relationship|keeping.your.information.safe.when.leaving|confirm.your.relationship|updating.your.relationship|using.referee.to.verify|support.services.for.separated|^ftb|deciding.to.separate|parental.income/i, category: 'families' },

  // ── Employment / work ──
  { pattern: /jobseeker|workforce.australia|employment|mutual.obligation|looking.for.work|recently.unemployed|working.credit|work.bonus|participation.requirements|redundancy|employment.separation|re.entering.workforce|looking.after.your.safety|working$|work$|work.health|meeting.*obligations.*work|if.you.have.reduced.capacity|inclusive.employment|providing.voluntary.work|manage.budget.*working|reporting|scheduled.reporting|unscheduled.reporting|employer.reporting|understanding.your.work.hours|supporting.your.employees/i, category: 'employment' },

  // ── Concessions / carers ──
  { pattern: /carer.payment|carer.allowance|carer.adjustment|carer.supplement|pensioner.concession|health.care.card|concession.card|commonwealth.seniors|breaks.from.caring|caring.for.someone|caring.for.myself|getting.payment.if.youre.carer|getting.support.if.youre.caring|taking.time.work.if.youre.caring|how.to.keep.your.carer|how.to.manage.carer|reviews.for.carer|while.you.wait.for.your.carer|examples.working.while.getting.carer|update.your.carer|providing.care.home|travel.*rules.for.carer/i, category: 'concessions' },

  // ── Pensions ──
  { pattern: /age.pension|pension.bonus|double.orphan.pension|pension.supplement|transitional.rate.pension|partner.service.pension|home.equity.access|retirement.years/i, category: 'pensions' },

  // ── Crisis / disasters / death ──
  { pattern: /crisis|natural.disaster|bereavement|disaster|bushfire|flooding|severe.weather|death|when.someone.dies|when.adult.dies|when.child.dies|loved.one.dies|what.to.organise.before.you.die|homelessness|emergency|support.services.when.adult.dies|what.help.available.when.loved|what.help.there.when|vic.bushfires|nth.qld.rainfall|nsw.east.coast|victoria.bushfires|understanding.government.disaster/i, category: 'crisis' },

  // ── Allowances / special benefit ──
  { pattern: /farm.household|rent.assistance|special.benefit|status.resolution|mobility.allowance|language.literacy.and.numeracy|energy.supplement|telephone.allowance|utilities.allowance|remote.area.allowance|fares.allowance|assurance.support|economic.support.payment|cost.living.payment|bass.strait|tasmanian.freight|weekly.payment|australian.victim.terrorism|pharmaceutical.allowance/i, category: 'allowances' },

  // ── Tax ──
  { pattern: /tax.time|tax.return|non.lodgement|taxable.centrelink|single.touch.payroll|deduct.tax|adjusted.taxable|what.families.need.to.do.tax|how.we.recover.debts.tax|how.to.prepare.for.tax|what.happens.after.*lodge.*tax|foreign.income.for.family/i, category: 'tax' },

  // ── Compliance / scams / fraud / robodebt ──
  { pattern: /scam|fraud|compliance.program|identity.theft|robodebt|data.breach|protecting.your.personal|how.you.can.protect.your.personal/i, category: 'compliance' },

  // ── Debt & repayment ──
  { pattern: /debt|repay.*money|money.you.owe|overpay|garnishee|pause.your.debt|how.to.avoid.overpayment/i, category: 'debt-repayment' },

  // ── International / overseas ──
  { pattern: /international|overseas|outside.australia|visiting.australia|new.zealand|social.security.agreement|reciprocal|returning.to.australia|leaving.australia|before.you.leave.australia|portability|exchange.rate.*international|proof.of.life/i, category: 'international' },

  // ── Income & assets ──
  { pattern: /income.test|assets.test|means.test|deeming|financial.invest|income.stream|asset.type|asset.hardship|real.estate|superannuation|private.trust|income.apportion|income.maintenance|income.from.self|sole.trader|financial.information.service|income$|financial.assets|manage.your.money|managing.your.money|how.to.budget|how.to.build.savings|choosing.to.rent.or.buy|understanding.loans|overdrawn.bank.account|better.financial|what.financial.information|compensation|annual.parental.income|living.arrangements|living.with.others|updating.your.bank.account|trust.reviews|manage.money.you.get|getting.financial.help|balancing.dates/i, category: 'income-assets' },

  // ── Digital services / online / apps / PRODA ──
  { pattern: /express.plus|online.account|proda|business.hub|business.online|self.service|voiceprint|electronic.messaging|digital.card|centrelink.letters.online|online.estimator|video.chat|book.appointment|how.to.get.help.using|how.to.manage.your.appointments|register.centrelink.letters|set.your.notifications|view.your.centrelink|unsubscribe.from.getting|managing.centrelink.letters|getting.centrelink.letters|what.you.can.do.with.centrelink.letters|security.and.privacy.for.centrelink|what.you.can.do.with.your.centrelink.online|what.details.you.can.view|when.you.can.access.your.centrelink|upload.your.centrelink|update.your.*using.your.centrelink|upload.forms.hpos|use.hpos.messages|manage.delegations.hpos|manage.your.details.hpos|connect.to.hpos|features.hpos|software.and.systems|get.started.software|electronic.verification.rent|how.centrelink.confirmation|how.to.apply.to.use.centrelink.confirmation|how.to.use.centrelink.confirmation|what.your.businesses.obligations.*evor|who.can.use.electronic|how.to.get.support.*electronic|lightweight.authentication|plaid/i, category: 'digital-services' },

  // ── Business services ──
  { pattern: /businesses|business.sectors|business.feedback|business.and.employer|how.centrepay.works|how.to.apply.for.centrepay|how.to.manage.your.business.*centrepay|your.businesses.obligations|your.obligations.to.use.centrepay|top.payments.for.businesses|most.useful.information.for.businesses|news.for.businesses|information.for.agent.and.access|rent.deduction.scheme|supporting.your.employees|information.for.income.stream|redundancy.information.for.employers|insurers.and.financial/i, category: 'businesses' },

  // ── myGov ──
  { pattern: /mygov|help.for.mygov/i, category: 'mygov' },

  // ── Corporate / about SA ──
  { pattern: /annual.report|corporate.plan|our.agency|^about.us$|reconciliation.action|audit.and.risk|sustainability|our.commitments|services.australia.2030|regulatory|freedom.information|public.interest.disclos|privacy.policy|privacy.impact|site.notices|our.website|workplace.belonging|strategies$|policies$|legislation$|media$|careers$|code.operation|community.engagement|community.partnership|community.groups|community.resources|mobile.service.centres|zero.tolerance|access.to.information|agents.and.access.point|stationery|report.cyber|public.holiday|personal.information.release|data.matching|data.analytics|cctv.privacy|automation.and.artificial|using.research|phone.us|write.to.us|find.us|connect.with.us|extra.help.when.calling|multicultural.servic|social.work.services|how.our.social.work|how.to.contact.social.work|privacy.using.social.work|customer.information.release|customer.service.changes|how.services.australia.protects|how.to.get.more.information|our.payments|how.we.can.help.you.with|where.to.get.help|explanations.and.formal.reviews|changes.services.australia|legal.professionals|how.to.use.our.forms|forms$|forms.code|forms.title|corrective.services|statement.commitment|when.we.may.contact|when.we.pre.fill|what.changes.you.need|how.mobile.service|accessible|new.starters|staff.and.delegations|your.right.to.privacy|your.responsibilities$|implementation.plan|national.redress|services.australia$|settle|how.to.dispose|protocols$|managing.nominee|someone.to.deal|nominee|how.to.prove.your.identity|how.to.update.your.name|how.to.upload.medical|updating.your.gender|whats.your.centrelink.payment.summary|what.happens.if.your.centrelink.payment.summary|cancelling.your.payment|while.you.wait.for.centrelink|how.to.get.immunisation|how.to.add.your.immunisation|what.immunisation|what.australian.immunisation|help.updating.your.immunisation|overseas.immunisation|heating.or.cooling|how.to.get.individual.healthcare|manage.your.centrelink.payment|get.centrelink.payment|how.your.variable.income|being.centrelink|how.you.can.help.students|pay.for.access|news$|request.information.using.subpoena|request.pay.group|verified.and.unverified|helping.someone.*prison|choose.collection|private.collect|moving.house|changing.your.address|housing$|manage.your.bills|getting.other.help|helping.you.transition|what.you.must.do|what.you.need.to.do.for|help.with.other.payments|your.circumstances.have.changed|how.to.manage.court|new.court.order|court.order.expiry|registering.*maintenance|submit.your.court|disputed.care|care.calendar|how.to.manage.my.current|how.to.pay.and.collect|recovering.child.and.spousal|bank.interest.income|income.and.assets.tests|eligible.equipment|managing.your.payment|how.much.*can.get|how.much.*you.can.get|how.secondary|what.services.you.can.access|what.refugee|what.family.and.domestic|helping.others.experiencing|looking.after.your.safety|help.from.other.places|how.we.can.help.with.international|seeking.medical.help|get.medical.help|most.useful.information|top.payments.for|news.for|what.help.available|fake.information|dont.fall|there.are.payments.to.support|claim.*subsid|register.care.setting|register.organisation|manage.complex|requirements.services|mbs.billing.for|mbs.and.dva.billing$|how.to.get.support.for.your.business|helping.you.get.right|going.overseas|waiting.periods$|ordinary.waiting|liquid.assets.waiting|seasonal.work.preclusion|how.work.bonus.works|types.income.we.apply|balance.*family.assistance|examples.to.help|payment.dates|what.happens.when.you.give|setting.up.online|how.to.get.energy|what.approved.reasons|when.and.how.to.tell|pause.requirements|identity.documents|how.to.register|managing.b2b|registering.subsidiary|understanding.management|managing.members|^accessibility$|accessing.our.services|aps.code.conduct|complaints.and.feedback|reports.and.statistics|transport.and.freight|privacy.notice|easypay/i, category: 'corporate' },

  // ── Centrelink (broad catch-all — should be LAST among keyword rules) ──
  { pattern: /centrelink|centrepay/i, category: 'centrelink' },

  // ── Payments (very broad, at end) ──
  { pattern: /^payment|payment$/i, category: 'payments' },
];

function inferCategoryFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, ''); // strip extension

  // 1. Form code detection (highly distinctive pattern)
  if (FORM_CODE_RE.test(base)) return 'forms';
  if (MOD_FORM_RE.test(base)) return 'forms';

  // 2. Language/translation file detection
  if (LANGUAGE_NAMES.has(base.toLowerCase())) return 'translations';
  if (/translation$/.test(base)) return 'translations';
  if (/^information.your.language|^help.your.language/.test(base)) return 'translations';

  // 3. Keyword-based category inference (specific → general)
  for (const rule of FILENAME_CATEGORY_RULES) {
    if (rule.pattern.test(base)) return rule.category;
  }

  // 4. Medical condition detection (broad catch-all for PBS drug pages)
  if (MEDICAL_RE.test(base)) return 'pharmaceutical-benefits';

  return null;
}

function extractDocMeta(filePath, domain = 'Westpac') {
  const parts = filePath.split('/');
  const meta = { brand: null, brandName: null, category: null, categoryName: null };
  const d = DOMAINS[domain] || DOMAINS.Westpac;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (d.brands[lower]) {
      meta.brand = lower;
      meta.brandName = d.brands[lower];
    }
    if (d.categories[lower]) {
      meta.category = lower;
      meta.categoryName = d.categories[lower];
    }
  }

  // For docs in 'general', try to infer a real category from the filename
  if (meta.category === 'general') {
    const inferred = inferCategoryFromFilename(parts[parts.length - 1]);
    if (inferred && d.categories[inferred]) {
      meta.category = inferred;
      meta.categoryName = d.categories[inferred];
    }
  }

  return meta;
}

module.exports = { extractEntities, extractDocMeta, inferCategoryFromFilename, DOMAINS };
