// Item library for "Random fill" — local curated set + helpers
// Used by Items section in event creator.

window.ITEM_LIBRARY = {
  silent: [
    { name: "Mexico beach getaway", desc: "5 nights for two at a beachfront villa, Riviera Maya.", category: "Travel", starting: 800, fmv: 3200, increment: 50 },
    { name: "Six-bottle Napa cellar", desc: "Curated reds from boutique Napa Valley wineries.", category: "Food & Wine", starting: 120, fmv: 480, increment: 20 },
    { name: "Custom oil portrait", desc: "Commissioned 18×24 oil portrait by local artist.", category: "Art", starting: 400, fmv: 1500, increment: 50 },
    { name: "Signed jersey — Local FC", desc: "Match-worn home kit, framed and authenticated.", category: "Sports", starting: 250, fmv: 700, increment: 25 },
    { name: "Pottery class for four", desc: "Three-session wheel-throwing workshop.", category: "Experiences", starting: 180, fmv: 400, increment: 20 },
    { name: "Symphony season opener", desc: "Two orchestra-level seats, opening night.", category: "Experiences", starting: 200, fmv: 600, increment: 25 },
    { name: "Smoked brisket dinner", desc: "Pitmaster-led dinner for eight at your home.", category: "Food & Wine", starting: 600, fmv: 1200, increment: 50 },
    { name: "Weekend cabin getaway", desc: "Two nights at a wood-fired lakeside cabin.", category: "Travel", starting: 350, fmv: 900, increment: 50 },
  ],
  live: [
    { name: "Tuscan villa, one week", desc: "Six guests, private chef one evening, transfers included.", category: "Travel", starting: 5000, fmv: 14000, increment: 250 },
    { name: "Box seats — championship game", desc: "Suite for eight with premium catering.", category: "Sports", starting: 3500, fmv: 9000, increment: 250 },
    { name: "Private chef dinner for ten", desc: "Five-course tasting menu, paired wines, your home.", category: "Food & Wine", starting: 2000, fmv: 5500, increment: 100 },
    { name: "Studio time with Grammy producer", desc: "Full-day session at a Brooklyn recording studio.", category: "Experiences", starting: 4000, fmv: 12000, increment: 250 },
    { name: "Signed Picasso lithograph", desc: "Authenticated, numbered, professionally framed.", category: "Art", starting: 8000, fmv: 22000, increment: 500 },
  ],
  fan: [
    { name: "Sponsor a classroom for a year", desc: "Funds books, supplies, and one field trip.", category: "Impact", starting: 0, fmv: 1500, increment: 0 },
    { name: "Provide 100 meals", desc: "Stocks our community kitchen for a week.", category: "Impact", starting: 0, fmv: 250, increment: 0 },
    { name: "Send a child to camp", desc: "Two weeks of summer camp for one kid.", category: "Impact", starting: 0, fmv: 800, increment: 0 },
    { name: "Fund a scholarship", desc: "One semester of tuition for a first-gen student.", category: "Impact", starting: 0, fmv: 5000, increment: 0 },
  ],
  raffle: [
    { name: "$5,000 cash drawing", desc: "Single winner, drawn live at the gala.", category: "Cash", starting: 50, fmv: 5000, increment: 0 },
    { name: "Diamond pendant raffle", desc: "0.75 ct round-cut, white gold setting.", category: "Jewelry", starting: 100, fmv: 4200, increment: 0 },
    { name: "Weekend in Vegas", desc: "Hotel + flight for two, dinner credit included.", category: "Travel", starting: 75, fmv: 2400, increment: 0 },
    { name: "Wine pull", desc: "Pull a cork — every bottle worth $40 or more.", category: "Food & Wine", starting: 25, fmv: 100, increment: 0 },
  ],
};

window.ITEM_TYPE_META = {
  silent: { label: "Silent auction", icon: "fa-gavel", color: "#0369a1" },
  live:   { label: "Live auction",   icon: "fa-microphone-stand", color: "#7c2d12" },
  fan:    { label: "Fund-a-need",    icon: "fa-heart",  color: "#be185d" },
  raffle: { label: "Raffle",         icon: "fa-ticket", color: "#a16207" },
};

window.randomItem = function(type) {
  const lib = window.ITEM_LIBRARY[type] || [];
  if (!lib.length) return null;
  const base = lib[Math.floor(Math.random() * lib.length)];
  return {
    id: 'it_' + Math.random().toString(36).slice(2, 9),
    type,
    ...base,
  };
};

window.blankItem = function(type) {
  return {
    id: 'it_' + Math.random().toString(36).slice(2, 9),
    type,
    name: '',
    desc: '',
    category: '',
    starting: 0,
    fmv: 0,
    increment: type === 'fan' || type === 'raffle' ? 0 : 25,
  };
};
