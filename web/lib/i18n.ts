/**
 * SUR Protocol - Internationalization (i18n)
 *
 * Minimal client-side i18n system.
 * Add new languages by adding a new object to TRANSLATIONS.
 */

export type Locale = "en" | "es" | "pt";

export const LOCALES: { key: Locale; label: string; flag: string }[] = [
  { key: "en", label: "English", flag: "🇺🇸" },
  { key: "es", label: "Español", flag: "🇦🇷" },
  { key: "pt", label: "Português", flag: "🇧🇷" },
];

const TRANSLATIONS: Record<Locale, Record<string, string>> = {
  en: {
    // Nav
    "nav.trade": "Trade",
    "nav.portfolio": "Portfolio",
    "nav.vaults": "Vaults",
    "nav.more": "More",
    "nav.leaderboard": "Leaderboard",
    "nav.referrals": "Referrals",
    "nav.points": "Points",
    "nav.support": "Support",
    "nav.connect": "Connect Wallet",

    // Trading
    "trade.placeOrder": "Place Order",
    "trade.long": "Long",
    "trade.short": "Short",
    "trade.limit": "Limit",
    "trade.market": "Market",
    "trade.stopLimit": "Stop Limit",
    "trade.size": "Size",
    "trade.price": "Price",
    "trade.leverage": "Leverage",
    "trade.takeProfit": "Take Profit",
    "trade.stopLoss": "Stop Loss",
    "trade.reduceOnly": "Reduce Only",
    "trade.hidden": "Hidden",
    "trade.notional": "Notional",
    "trade.margin": "Margin",
    "trade.fee": "Fee",
    "trade.liqPrice": "Liq. Price",
    "trade.available": "Available",
    "trade.tif": "Time in Force",
    "trade.filling": "Filling...",
    "trade.signing": "Signing...",

    // Positions
    "positions.title": "Positions",
    "positions.openOrders": "Open Orders",
    "positions.tradeHistory": "Trade History",
    "positions.funding": "Funding",
    "positions.noPositions": "No open positions",
    "positions.noOrders": "No open orders",
    "positions.noHistory": "No trade history yet",
    "positions.close": "Close",
    "positions.cancel": "Cancel",

    // Account
    "account.title": "Account",
    "account.equity": "Equity",
    "account.balance": "Balance",
    "account.unrealizedPnl": "Unrealized PnL",
    "account.realizedPnl": "Realized PnL",
    "account.marginUsed": "Margin Used",
    "account.reset": "Reset",

    // Deposit
    "deposit.title": "Deposit",
    "deposit.withdraw": "Withdraw",
    "deposit.wallet": "Wallet",
    "deposit.vault": "Vault",
    "deposit.amount": "Deposit Amount",
    "deposit.withdrawAmount": "Withdraw Amount",
    "deposit.enterAmount": "Enter Amount",
    "deposit.connectWallet": "Connect your wallet to deposit funds and start trading",

    // Header
    "header.live": "Live",
    "header.connecting": "Connecting...",
    "header.offline": "Offline",
    "header.paperTrading": "Paper Trading",
    "header.vol24h": "24h Vol",
    "header.oi": "OI",
    "header.funding": "Funding",

    // Support
    "support.title": "Support",
    "support.faq": "Frequently Asked Questions",
    "support.contact": "Contact Us",
    "support.send": "Send Message",

    // Footer
    "footer.privacy": "Privacy Policy",
    "footer.terms": "Terms of Service",
    "footer.support": "Support",
  },

  es: {
    "nav.trade": "Operar",
    "nav.portfolio": "Portafolio",
    "nav.vaults": "Bóvedas",
    "nav.more": "Más",
    "nav.leaderboard": "Ranking",
    "nav.referrals": "Referidos",
    "nav.points": "Puntos",
    "nav.support": "Soporte",
    "nav.connect": "Conectar Wallet",

    "trade.placeOrder": "Crear Orden",
    "trade.long": "Long",
    "trade.short": "Short",
    "trade.limit": "Límite",
    "trade.market": "Mercado",
    "trade.stopLimit": "Stop Limit",
    "trade.size": "Tamaño",
    "trade.price": "Precio",
    "trade.leverage": "Apalancamiento",
    "trade.takeProfit": "Take Profit",
    "trade.stopLoss": "Stop Loss",
    "trade.reduceOnly": "Solo Reducir",
    "trade.hidden": "Oculta",
    "trade.notional": "Nocional",
    "trade.margin": "Margen",
    "trade.fee": "Comisión",
    "trade.liqPrice": "Precio Liq.",
    "trade.available": "Disponible",
    "trade.tif": "Vigencia",
    "trade.filling": "Ejecutando...",
    "trade.signing": "Firmando...",

    "positions.title": "Posiciones",
    "positions.openOrders": "Órdenes Abiertas",
    "positions.tradeHistory": "Historial",
    "positions.funding": "Funding",
    "positions.noPositions": "Sin posiciones abiertas",
    "positions.noOrders": "Sin órdenes abiertas",
    "positions.noHistory": "Sin historial de operaciones",
    "positions.close": "Cerrar",
    "positions.cancel": "Cancelar",

    "account.title": "Cuenta",
    "account.equity": "Capital",
    "account.balance": "Balance",
    "account.unrealizedPnl": "PnL No Realizado",
    "account.realizedPnl": "PnL Realizado",
    "account.marginUsed": "Margen Usado",
    "account.reset": "Reiniciar",

    "deposit.title": "Depositar",
    "deposit.withdraw": "Retirar",
    "deposit.wallet": "Wallet",
    "deposit.vault": "Bóveda",
    "deposit.amount": "Monto a Depositar",
    "deposit.withdrawAmount": "Monto a Retirar",
    "deposit.enterAmount": "Ingresar Monto",
    "deposit.connectWallet": "Conectá tu wallet para depositar fondos y empezar a operar",

    "header.live": "En Vivo",
    "header.connecting": "Conectando...",
    "header.offline": "Desconectado",
    "header.paperTrading": "Paper Trading",
    "header.vol24h": "Vol 24h",
    "header.oi": "OI",
    "header.funding": "Funding",

    "support.title": "Soporte",
    "support.faq": "Preguntas Frecuentes",
    "support.contact": "Contáctanos",
    "support.send": "Enviar Mensaje",

    "footer.privacy": "Política de Privacidad",
    "footer.terms": "Términos de Servicio",
    "footer.support": "Soporte",
  },

  pt: {
    "nav.trade": "Negociar",
    "nav.portfolio": "Portfólio",
    "nav.vaults": "Cofres",
    "nav.more": "Mais",
    "nav.leaderboard": "Ranking",
    "nav.referrals": "Indicações",
    "nav.points": "Pontos",
    "nav.support": "Suporte",
    "nav.connect": "Conectar Carteira",

    "trade.placeOrder": "Criar Ordem",
    "trade.long": "Long",
    "trade.short": "Short",
    "trade.limit": "Limite",
    "trade.market": "Mercado",
    "trade.stopLimit": "Stop Limit",
    "trade.size": "Tamanho",
    "trade.price": "Preço",
    "trade.leverage": "Alavancagem",
    "trade.takeProfit": "Take Profit",
    "trade.stopLoss": "Stop Loss",
    "trade.reduceOnly": "Apenas Reduzir",
    "trade.hidden": "Oculta",
    "trade.notional": "Nocional",
    "trade.margin": "Margem",
    "trade.fee": "Taxa",
    "trade.liqPrice": "Preço Liq.",
    "trade.available": "Disponível",
    "trade.tif": "Validade",
    "trade.filling": "Executando...",
    "trade.signing": "Assinando...",

    "positions.title": "Posições",
    "positions.openOrders": "Ordens Abertas",
    "positions.tradeHistory": "Histórico",
    "positions.funding": "Funding",
    "positions.noPositions": "Sem posições abertas",
    "positions.noOrders": "Sem ordens abertas",
    "positions.noHistory": "Sem histórico de operações",
    "positions.close": "Fechar",
    "positions.cancel": "Cancelar",

    "account.title": "Conta",
    "account.equity": "Patrimônio",
    "account.balance": "Saldo",
    "account.unrealizedPnl": "PnL Não Realizado",
    "account.realizedPnl": "PnL Realizado",
    "account.marginUsed": "Margem Usada",
    "account.reset": "Resetar",

    "deposit.title": "Depositar",
    "deposit.withdraw": "Sacar",
    "deposit.wallet": "Carteira",
    "deposit.vault": "Cofre",
    "deposit.amount": "Valor do Depósito",
    "deposit.withdrawAmount": "Valor do Saque",
    "deposit.enterAmount": "Inserir Valor",
    "deposit.connectWallet": "Conecte sua carteira para depositar fundos e começar a negociar",

    "header.live": "Ao Vivo",
    "header.connecting": "Conectando...",
    "header.offline": "Offline",
    "header.paperTrading": "Paper Trading",
    "header.vol24h": "Vol 24h",
    "header.oi": "OI",
    "header.funding": "Funding",

    "support.title": "Suporte",
    "support.faq": "Perguntas Frequentes",
    "support.contact": "Fale Conosco",
    "support.send": "Enviar Mensagem",

    "footer.privacy": "Política de Privacidade",
    "footer.terms": "Termos de Serviço",
    "footer.support": "Suporte",
  },
};

const LOCALE_KEY = "sur_locale";

export function getLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved && saved in TRANSLATIONS) return saved as Locale;
  } catch {}
  // Auto-detect from browser
  const lang = navigator.language?.slice(0, 2);
  if (lang === "es") return "es";
  if (lang === "pt") return "pt";
  return "en";
}

export function setLocale(locale: Locale) {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {}
}

export function t(key: string, locale?: Locale): string {
  const l = locale || getLocale();
  return TRANSLATIONS[l]?.[key] || TRANSLATIONS.en[key] || key;
}
