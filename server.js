bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (!userSessions[userId]) userSessions[userId] = { state: 'AWAITING_COUNTRY' };
  const session = userSessions[userId];

  // 1. Check for "Available Services" Intent (e.g. "Which one dey available?", "check for available number")
  const isAvailableQuery = [
    'available', 'which one', 'what is available', 'list', 'show', 'any number', 'which app'
  ].some(keyword => lowerText.includes(keyword));

  if (isAvailableQuery) {
    if (!session.country) {
      ctx.reply(`Please tell me which country you want to check first! (e.g., _United States_, _Nigeria_)`, { parse_mode: 'Markdown' });
      session.state = 'AWAITING_COUNTRY';
      return;
    }

    ctx.reply(`Checking all available services for *${session.country.name}*... 🔎`, { parse_mode: 'Markdown' });
    
    // Fetch all stock for selected country
    const available = await fetchCombinedServices(session.country);

    if (!available || available.length === 0) {
      ctx.reply(`Eya! No services are available right now for *${session.country.name}*. Please try another country!`, { parse_mode: 'Markdown' });
      return;
    }

    // Group services by name and take top available items
    const uniqueServices = Array.from(new Set(available.map(s => s.service_name))).slice(0, 15);

    let message = `Here are the top available services for *${session.country.name}* right now: 👇\n\n`;
    uniqueServices.forEach((srv) => {
      message += `• *${srv}*\n`;
    });
    message += `\nType the name of any service above to check prices and buy!`;

    ctx.reply(message, { parse_mode: 'Markdown' });
    session.state = 'AWAITING_SERVICE';
    return;
  }

  // 2. Standard Greetings
  if (['hi', 'hello', 'hey', 'awfa', 'howfar', 'how far', 'xup'].some(g => lowerText.includes(g))) {
    ctx.reply(
      `How far my boss! 😊 My name na *Elsa*, welcome to *MJ SMS*!\n` +
      `Have a happy day today! ✨\n\n` +
      `Which country virtual number you wan buy today? Just drop the country name for me.`
    );
    session.state = 'AWAITING_COUNTRY';
    return;
  }

  const countries = await getCountries();

  // 3. Multi-word input detection ("USA WhatsApp")
  if (countries.length > 0) {
    const words = lowerText.split(/\s+/);
    let matchedCountry = null;
    let matchedServiceQuery = null;

    for (const word of words) {
      const found = countries.find(c => 
        c.name.toLowerCase() === word || 
        c.short.toLowerCase() === word ||
        (word === 'usa' && c.short.toLowerCase() === 'us') ||
        (word === 'uk' && c.short.toLowerCase() === 'gb')
      );
      if (found) {
        matchedCountry = found;
        matchedServiceQuery = words.filter(w => w !== word).join(' ');
        break;
      }
    }

    if (matchedCountry && matchedServiceQuery) {
      session.country = matchedCountry;
      session.state = 'AWAITING_SERVICE';
      ctx.reply(`Oya wait make Elsa check available servers for *${matchedServiceQuery}* (${matchedCountry.name})... 🔎`, { parse_mode: 'Markdown' });
      await processServiceSelection(ctx, session, matchedServiceQuery);
      return;
    }
  }

  // 4. Country Selection Logic
  if (session.state === 'AWAITING_COUNTRY' || session.state === 'IDLE') {
    ctx.reply(`Hold on boss, make I check available countries... 🔎`);
    
    const matchedCountry = countries.find(c => 
      c.name.toLowerCase().includes(lowerText) || 
      c.short.toLowerCase() === lowerText ||
      (lowerText === 'usa' && c.short.toLowerCase() === 'us') ||
      (lowerText === 'uk' && c.short.toLowerCase() === 'gb')
    );

    if (matchedCountry) {
      session.country = matchedCountry;
      session.state = 'AWAITING_SERVICE';
      ctx.reply(
        `Ehen! You select *${matchedCountry.name}* 👌\n\n` +
        `Which app or service you wan verify? (e.g. _WhatsApp_, _Telegram_, _Facebook_)`,
        { parse_mode: 'Markdown' }
      );
    } else {
      ctx.reply(`I no find "*${rawText}*" for available countries boss. Try *United States*, *United Kingdom*, or *Nigeria*!`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // 5. Service Selection Logic
  if (session.state === 'AWAITING_SERVICE') {
    const newCountryMatch = countries.find(c => 
      c.name.toLowerCase() === lowerText || 
      c.short.toLowerCase() === lowerText ||
      (lowerText === 'usa' && c.short.toLowerCase() === 'us')
    );

    if (newCountryMatch) {
      session.country = newCountryMatch;
      ctx.reply(`Switched country to *${newCountryMatch.name}* 👌\n\nWhich app or service you wan verify?`, { parse_mode: 'Markdown' });
      return;
    }

    ctx.reply(`Oya wait make Elsa check available servers for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
    await processServiceSelection(ctx, session, rawText);
  }
});
