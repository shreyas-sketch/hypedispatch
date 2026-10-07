// The recurring workshops. Each one is set up once (fact sheet from its landing page),
// then every dated run just picks a programme + a community.
// `title` + `host` are the official workshop name and host used in every message (they override the fact sheet).
// `signature` is added by code at the very end of every message (after the links). *text* = WhatsApp bold.
export const SEED_PROGRAMMES = [
  { name: 'Akshat Consulting', title: 'High Value Consulting Workshop', host: 'Akshat Dani', landingUrl: 'https://highvalueconsulting.net/consulting-workshop/', signature: '*Team Akshat Dani*' },
  { name: 'Siddharth Ecom', title: 'Launch Method Workshop', host: 'Siddharth Kapoor', landingUrl: 'https://thelaunchblueprint.com/3-hour-workshop/', signature: '*Team Siddharth Kapoor*' },
  { name: 'Siddharth Consulting', title: 'High Value Consulting Workshop', host: 'Siddharth Kapoor', landingUrl: 'https://webinar.highvalueconsulting.net/live-consulting-workshop/', signature: '*Team Siddharth Kapoor*' },
  { name: 'Siddharth Algo Trading', title: 'Algo Trading Workshop', host: 'Siddharth Kapoor', landingUrl: 'https://join.finkhoz.com/siddharth-kapoor', signature: '*Team Siddharth Kapoor*\nwww.siddharthkapoor.in' },
  { name: 'Aarzoo Personal Finance', title: 'Decode Your Wealth', host: 'Aarzoo Shah', landingUrl: 'https://join.finkhoz.com/personal-finance-aarzoo-shah', signature: '*Team Aarzoo Shah*\nwww.aarzooshah.com' },
  { name: 'Aarzoo Leadership', title: 'Leadership Code Masterclass', host: 'Aarzoo Shah', landingUrl: 'https://aarzooshahleadership.com/leadership-blueprint-masterclass/', signature: '*Team Aarzoo Shah*' },
  { name: 'Aarzoo Communication', title: 'Communication Mastery Workshop', host: 'Aarzoo Shah', landingUrl: 'https://communicate.aarzooshah.com/master-communication-lp/', signature: '*Team Aarzoo Shah*' },
  { name: 'Deepak Crypto', title: 'Digital Wealth Domination Workshop', host: 'Deepak Choudhary', landingUrl: 'https://workshop.digitalwealthdomination.in', signature: '*Team Deepak Choudhary*\nchoudharydeepak.com' },
  { name: 'BO Akshat', title: '2-Day Business Owners Workshop', host: 'Akshat Dani', landingUrl: 'https://businessaiblueprint.net/business-ai/', signature: '*Team Akshat Dani*\nakshatdani.com' },
  {
    name: 'BO Chirag', title: '2-Day Business Owners Workshop', host: 'Chirag Jhumkhawala', landingUrl: 'https://go.blackelephant.in/live-be-business-owners', signature: '*Team Business AI Automation*',
    focus: 'The AI for business owners masterclass. This page also advertises a data science programme: ignore that part.',
  },
];
