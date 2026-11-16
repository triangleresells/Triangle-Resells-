/** Common Spanish words in DMs (accents optional, texting short forms included). Two or more = Spanish. */
const SPANISH_WORDS = new Set(
  "hola que q k cuanto cuánto cuesta sale tienes tienen tiene talla tallas quiero quisiera puedo puedes para pa por porfa xfa gracias si sí bueno buenas buenos dias días tardes noches donde dónde cuando cuándo envio envío envian envían mandar manda pago pagar efectivo color negro negra blanco blanca gris rojo azul esta está estan están hay disponible precio precios ropa sudadera camisa playera pantalon pantalón gorra perfume oye wey güey carnal neta ahorita mande orale órale chido chida va vale claro nomas nomás tambien también tmb xq porque pq cual cuál cuales cuáles mi mis tu tus del los las una uno unos unas como cómo saludos amigo hermano"
    .split(" "),
);
/** True when the buyer writes in Spanish (or mostly Spanish Spanglish), from their recent messages. */
export function looksSpanish(texts: string[]): boolean {
  const words = texts.slice(-4).join(" ").toLowerCase().normalize("NFC").match(/[a-záéíóúñü]+/g) ?? [];
  const hits = words.filter((w) => SPANISH_WORDS.has(w)).length;
  return hits >= 2 && hits / Math.max(words.length, 1) >= 0.25;
}

