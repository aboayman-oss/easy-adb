// Friendly marketing names for devices whose model property is a code (mostly Samsung).

const SAMSUNG: Record<string, string> = {
  // Galaxy S
  S931: 'Galaxy S25', S936: 'Galaxy S25+', S938: 'Galaxy S25 Ultra', S937: 'Galaxy S25 Edge', S731: 'Galaxy S25 FE',
  S921: 'Galaxy S24', S926: 'Galaxy S24+', S928: 'Galaxy S24 Ultra', S721: 'Galaxy S24 FE',
  S911: 'Galaxy S23', S916: 'Galaxy S23+', S918: 'Galaxy S23 Ultra', S711: 'Galaxy S23 FE',
  S901: 'Galaxy S22', S906: 'Galaxy S22+', S908: 'Galaxy S22 Ultra',
  G991: 'Galaxy S21', G996: 'Galaxy S21+', G998: 'Galaxy S21 Ultra', G990: 'Galaxy S21 FE',
  G981: 'Galaxy S20', G986: 'Galaxy S20+', G988: 'Galaxy S20 Ultra', G780: 'Galaxy S20 FE', G781: 'Galaxy S20 FE 5G',
  G970: 'Galaxy S10e', G973: 'Galaxy S10', G975: 'Galaxy S10+',
  // Galaxy Z
  F966: 'Galaxy Z Fold7', F766: 'Galaxy Z Flip7', F761: 'Galaxy Z Flip7 FE',
  F956: 'Galaxy Z Fold6', F741: 'Galaxy Z Flip6',
  F946: 'Galaxy Z Fold5', F731: 'Galaxy Z Flip5',
  F936: 'Galaxy Z Fold4', F721: 'Galaxy Z Flip4',
  F926: 'Galaxy Z Fold3', F711: 'Galaxy Z Flip3',
  // Galaxy Note
  N986: 'Galaxy Note20 Ultra', N981: 'Galaxy Note20', N975: 'Galaxy Note10+', N970: 'Galaxy Note10',
  // Galaxy A
  A566: 'Galaxy A56', A366: 'Galaxy A36', A266: 'Galaxy A26', A165: 'Galaxy A16', A166: 'Galaxy A16 5G',
  A556: 'Galaxy A55', A356: 'Galaxy A35', A256: 'Galaxy A25', A155: 'Galaxy A15', A156: 'Galaxy A15 5G',
  A546: 'Galaxy A54', A346: 'Galaxy A34', A245: 'Galaxy A24', A145: 'Galaxy A14', A146: 'Galaxy A14 5G',
  A536: 'Galaxy A53', A336: 'Galaxy A33', A235: 'Galaxy A23', A236: 'Galaxy A23 5G', A135: 'Galaxy A13', A137: 'Galaxy A13',
  A525: 'Galaxy A52', A526: 'Galaxy A52 5G', A528: 'Galaxy A52s', A325: 'Galaxy A32', A326: 'Galaxy A32 5G',
  A225: 'Galaxy A22', A226: 'Galaxy A22 5G', A125: 'Galaxy A12', A127: 'Galaxy A12',
  A515: 'Galaxy A51', A715: 'Galaxy A71', A505: 'Galaxy A50', A705: 'Galaxy A70',
  A055: 'Galaxy A05', A057: 'Galaxy A05s', A065: 'Galaxy A06', A066: 'Galaxy A06 5G', A045: 'Galaxy A04', A047: 'Galaxy A04s',
  // Galaxy M / F
  M156: 'Galaxy M15', M346: 'Galaxy M34', M546: 'Galaxy M54', M336: 'Galaxy M33', M536: 'Galaxy M53', M146: 'Galaxy M14',
  // Tabs
  X910: 'Galaxy Tab S9 Ultra', X916: 'Galaxy Tab S9 Ultra', X810: 'Galaxy Tab S9+', X710: 'Galaxy Tab S9',
  X920: 'Galaxy Tab S10 Ultra', X820: 'Galaxy Tab S10+', X510: 'Galaxy Tab S9 FE', X610: 'Galaxy Tab S9 FE+',
  X200: 'Galaxy Tab A8', X110: 'Galaxy Tab A9', X210: 'Galaxy Tab A9+'
}

/** Property keys that hold a marketing name on various ROMs, most specific first. */
export const MARKET_NAME_PROPS = [
  'ro.product.marketname',
  'ro.product.vendor.marketname',
  'ro.product.odm.marketname',
  'ro.vendor.oplus.market.name',
  'ro.oppo.market.name',
  'ro.config.marketing_name',
  'ro.vivo.market.name',
  'ro.product.model.display'
]

export function marketingName(props: Record<string, string>): string | undefined {
  for (const key of MARKET_NAME_PROPS) {
    const v = props[key]?.trim()
    if (v) return v
  }
  const model = props['ro.product.model'] ?? ''
  const m = /^SM-([A-Z]\d{3})/i.exec(model)
  if (m) return SAMSUNG[m[1].toUpperCase()]
  return undefined
}

export function friendlyBrand(props: Record<string, string>): string {
  const raw = (props['ro.product.brand'] || props['ro.product.manufacturer'] || '').trim()
  if (!raw) return 'Android'
  const lower = raw.toLowerCase()
  const known: Record<string, string> = {
    samsung: 'Samsung', google: 'Google', xiaomi: 'Xiaomi', redmi: 'Redmi', poco: 'POCO', oneplus: 'OnePlus',
    oppo: 'OPPO', realme: 'realme', motorola: 'Motorola', huawei: 'Huawei', honor: 'HONOR', vivo: 'vivo',
    nothing: 'Nothing', sony: 'Sony', nokia: 'Nokia', asus: 'ASUS', lenovo: 'Lenovo', tecno: 'TECNO', infinix: 'Infinix'
  }
  return known[lower] ?? raw.charAt(0).toUpperCase() + raw.slice(1)
}
