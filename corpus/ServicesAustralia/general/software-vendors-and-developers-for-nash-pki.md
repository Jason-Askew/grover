---
url: https://www.servicesaustralia.gov.au/software-vendors-and-developers-for-nash-pki
title: Software vendors and developers for NASH PKI - Health professionals - Services AustraliaServices AustraliaServices Australia
scrapedAt: 2026-02-17T20:37:00.689Z
source: servicesaustralia.gov.au
---
# Software vendors and developers for NASH PKI

Find out about NASH PKI certificates to help software developers or vendors that work in health care provider organisations.

## on this page

-   [NASH PKI test kit](#a1)
-   [NASH PKI certificate compatibility matrix](#a2)
-   [NASH operational requirements](#a3)

National Authentication Service for Health (NASH) Public Key Infrastructure (PKI) certificates let health care providers and supporting organisations securely communicate and exchange health information electronically.

These certificates:

-   are used to access the My Health Record system and Healthcare Identifiers (HI) Service
-   provide confidence in the integrity of information transmitted
-   provide the secure exchange of health information with other health care providers.

## NASH PKI test kit

You can use a NASH PKI test kit to authenticate in the test environment for:

-   the My Health Record system
-   the HI Service
-   electronic prescriptions
-   sending and receiving secure messages.

NASH PKI test kits can’t be used in:

-   the My Health Record production environment
-   the HI Service production environment
-   any other online program.

When you apply for a test kit, you agree to the terms and conditions of licence. When using the test kit, you’re bound by these terms and conditions.

You can apply for a NASH PKI test kit and explain why you need the test kit by emailing the [developerliaison@servicesaustralia.gov.au](mailto:developerliaison@servicesaustralia.gov.au).

We’ll direct you to register in the Health Systems Developer Portal if required.

### Certificates in the NASH PKI test kit

When you get the NASH PKI test kit, check it has the following certificates:

-   an active test NASH PKI certificate for Healthcare Provider Organisations for 2 test organisations
-   a revoked test NASH PKI certificate for Healthcare Provider Organisations for a test organisation, if requested
-   an active test NASH PKI certificate for Supporting Organisations for a test organisation, if requested.

Test organisation names vary in different test kits. Any HI embedded in the certificates are test health care identifiers only.

Test certificates are valid for 2 years.

### Using the active test certificates

Use both active test NASH PKI certificates for Healthcare Provider Organisations to:

-   check secure messaging is operating correctly
-   check the NASH Test Directory can be accessed.

Use the active test NASH PKI certificate for Supporting Organisations to:

-   check secure messaging is working between intermediary organisations
-   check the NASH Test Directory can be accessed with a supporting organisation NASH PKI certificate.

### Using the revoked test certificates

Use the revoked test NASH PKI certificates for Healthcare Provider Organisation for the following:

-   Check secure messaging can’t occur when one of the organisations has a revoked certificate. Use one of the test NASH PKI certificate for Healthcare Provider Organisations to test this.
-   Confirm an organisation can’t access the NASH Test Directory when they use a revoked certificate.

### Installing test certificates

If you need technical support to install the certificates [call us](/health-professionals-contact-information?context=20#ots).

## NASH PKI certificate compatibility matrix

This table shows the usage summary for NASH, My Health Record, secure messaging and the HI Service.

Certificate type

My Health Record system

NASH

HI Service

Secure messaging

 

**B2B**

**National Provider Portal**

**NASH Directory**

**HPOS**

**B2B**

**B2B**

NASH PKI Certificate for Healthcare Provider Organisations  
1.20.1.1

Yes

No

Yes

No

Yes

Yes

NASH PKI Certificate for Supporting Organisations  
1.22.1.1

Yes

No

Yes

No

Yes

No

Individual PRODA

No

Yes

No

Yes

No

No

## NASH operational requirements

### Personal identification code (PIC)

A personal identification code (PIC) is the secure code you need to access your certificate. The certificate will be locked if the PIC has been entered incorrectly 3 times.

The NASH PKI test kit includes a PIC for each certificate to install the test certificate. If you lose your PIC, email [developerliaison@servicesaustralia.gov.au](mailto:developerliaison@servicesaustralia.gov.au).

### Expiring certificates

NASH PKI test certificates have a lifespan of 2 years. To keep using test certificates, you should contact us to start the replacement process at least one month before your NASH PKI test certificates expire.

You can replace your NASH PKI test certificates by emailing [developerliaison@servicesaustralia.gov.au](mailto:developerliaison@servicesaustralia.gov.au).

Certificates can be revoked if they’re:

-   lost
-   compromised
-   no longer required.

If you still need them, lost certificates can be revoked and then replaced.

Support for revoked certificates is available by [calling us](/health-professionals-contact-information?context=20#ots).

The NASH Directory is a secure directory of active NASH PKI certificates for Healthcare Provider Organisations and supporting organisations. You can use key words to search the NASH Directory to find an entity’s PKI certificate.

You can access the NASH Directory and NASH Test Directory through the [Certificates Australia](http://www.certificates-australia.com.au/) website.

### Legislative, privacy and policy requirements

A Health care organisation’s healthcare identifier is embedded in its NASH PKI certificate.

The _Healthcare Identifiers Act 2010_ regulates the use and disclosure of health care identifiers.

It’s important your organisation makes sure certificates are always used for the purpose of providing health care.

Find out more about [specific certificate policies](/pki-policy-documents?context=20).
