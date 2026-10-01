/**
 * SlugFactory — human-readable run-name generation.
 *
 * Generates three-word names in `adjective-color-noun` format drawn from
 * curated word lists (~370 adjectives × ~86 colors × ~200 nouns ≈ 65 M
 * combinations). All words are positive or neutral — no negative connotations.
 *
 * `generate()` returns a fresh random slug on every call.
 * Collision handling (per-org uniqueness) is owned by `RunService.create`,
 * which appends a numeric suffix (`-1`, `-2`, …) when a collision is found.
 */

export class SlugFactory {
    private static readonly ADJECTIVES: readonly string[] = [
        // A
        'able','abundant','accomplished','accurate','actionable','active','adaptable',
        'adept','admirable','admired','adroit','affable','agile','aglow','agreeable',
        'alight','alive','ambitious','amiable','ample','animated','appreciative',
        'approachable','apt','ardent','artful','aspiring','aspirational','assured',
        'attentive','attuned','authentic','avid','aware',
        // B
        'balanced','becoming','beneficent','benevolent','bold','bountiful','brave',
        'bright','brisk','buoyant',
        // C
        'calm','candid','capable','careful','caring','celebrated','centered','certain',
        'cheerful','civic','civil','clean','clear','clever','cohesive','collaborative',
        'collected','committed','compassionate','composed','comprehensive','concise',
        'confident','conscious','consistent','constructive','cool','courageous',
        'courteous','creative','crisp','cultivated','curious',
        // D
        'dauntless','decisive','dedicated','deep','deft','deliberate','dependable',
        'determined','devoted','dignified','diligent','direct','discerning',
        'distinguished','driven','durable','dynamic',
        // E
        'eager','earnest','easy','easygoing','educated','effective','efficient',
        'elegant','eloquent','eminent','empowered','enabling','enduring','energetic',
        'engaged','enlightened','enriching','enterprising','enthusiastic','equitable',
        'essential','esteemed','exact','excellent','exceptional','exemplary',
        'expansive','expert',
        // F
        'fair','faithful','farsighted','fast','fervent','fertile','fine','firm',
        'fleet','flexible','flourishing','fluent','focused','forthright','fortunate',
        'forward','free','fresh','fruitful',
        // G
        'gallant','generous','genuine','gifted','giving','glad','glowing','golden',
        'good','graceful','gracious','grand','great','grounded',
        // H
        'hale','hardy','harmonious','healthy','heartened','heartfelt','helpful',
        'honed','honest','hopeful','humble',
        // I
        'ideal','idealistic','illumined','imaginative','immaculate','impactful',
        'impartial','incisive','inclusive','independent','industrious','informed',
        'ingenious','innovative','insightful','inspired','integral','intelligent',
        'intent','intuitive','inventive',
        // J
        'joyful','jubilant','judicious','just',
        // K
        'keen','kind','kindred','knowing',
        // L
        'lasting','laudable','leading','learned','lean','liberal','light','lithe',
        'lively','lofty','logical','loyal','lucid','luminous',
        // M
        'masterful','meaningful','measured','meritorious','meticulous','methodical',
        'mindful','modern','modular','motivated',
        // N
        'natural','nimble','noble','notable','noteworthy','nourishing','nurturing',
        // O
        'objective','observant','open','optimal','optimistic','orderly','organized',
        'original','outstanding','outgoing',
        // P
        'paramount','passionate','patient','peaceable','peaceful','perennial',
        'perceptive','persevering','persistent','pioneering','plain','plentiful',
        'poised','polished','positive','powerful','pragmatic','precise','principled',
        'proactive','productive','professional','progressive','prolific','promising',
        'prompt','proven','pure',
        // Q
        'qualified','quick','quiet',
        // R
        'radiant','rapid','rational','ready','receptive','recognized','refined',
        'refreshed','refreshing','reliable','remarkable','renewing','reputable',
        'resilient','resolute','resourceful','responsive','rich','robust','rooted','rounded',
        // S
        'safe','savvy','seasoned','secure','select','serene','sharp','shining',
        'simple','sincere','skilled','smooth','soaring','solid','soulful','sound',
        'spare','spirited','steadfast','steady','stellar','sterling','strategic',
        'strong','sturdy','subtle','supportive','sustainable','swift','systematic',
        // T
        'tactful','talented','tenacious','thankful','terse','thorough','thoughtful',
        'thriving','tidy','timeless','timely','tireless','tolerant','transformative',
        'transparent','trim','true','trusted',
        // U
        'unbound','unified','unique','unifying','universal','unwavering','uplifting',
        'upright','upstanding','useful',
        // V
        'valiant','valuable','vast','venerable','versatile','vibrant','vigilant',
        'vigorous','virtuous','visionary','vital','vivid',
        // W
        'warm','watchful','welcome','welcoming','wholesome','wide','willing',
        'winning','wise','worthy',
        // Y
        'yielding','youthful',
        // Z
        'zealous','zestful',
    ];

    private static readonly COLORS: readonly string[] = [
        'amber','aqua','auburn','azure',
        'beige','bisque','blue','bronze',
        'carmine','celadon','cerulean','champagne','charcoal','chartreuse','cherry',
        'citrine','cobalt','copper','coral','crimson','cyan',
        'denim','dusk',
        'ebony','ecru','emerald',
        'fawn','flint','fuchsia',
        'garnet','gold','gray','green',
        'honey',
        'indigo','ivory',
        'jade',
        'khaki',
        'lavender','lemon','lilac','lime',
        'magenta','mahogany','maroon','mauve','mint','mocha',
        'navy',
        'ochre','olive','onyx','opal','orange',
        'pearl','periwinkle','pewter','pine','plum','platinum',
        'rose','rouge','ruby','rust',
        'sable','sage','sand','sapphire','scarlet','sepia','sienna','silver','slate','snow','steel',
        'tan','teal','titian','topaz','turquoise',
        'umber',
        'vermillion','violet',
        'white','wine',
        'yellow',
    ];

    private static readonly NOUNS: readonly string[] = [
        // A
        'anchor','apex','arbor','arch','arc','atlas','atoll',
        // B
        'basin','bay','beacon','bluff','bloom','bough','brae','bridge','brook','butte',
        // C
        'cairn','canoe','canopy','cape','cascade','cavern','cedar','channel',
        'chase','chasm','cinder','cirque','cliff','cloud','coast','copse',
        'cove','crag','crater','crest','croft','crown','crystal','current',
        // D
        'dale','dawn','delta','den','depth','dew','dome','drift','dune','dusk',
        // E
        'earth','echo','edge','eddy','ember','estuary',
        // F
        'falls','fen','fern','field','firn','fjord','flare','flat','floe',
        'flow','flume','fog','ford','forge','fork','fort','forest','frost',
        // G
        'gale','gap','gem','geyser','glade','gleam','glen','gorge','granite',
        'grass','grotto','grove','gulf','gust',
        // H
        'harbor','haven','hearth','heath','highland','hill','hollow','horizon',
        // I
        'inlet','island','islet',
        // J
        'jetty',
        // K
        'keel','kelp','knoll',
        // L
        'lagoon','lake','lea','ledge','light','loch','loft',
        // M
        'mantle','marble','marsh','meadow','mesa','mile','mill','mirror','mist','moor','moss','mount',
        // N
        'narrows','nebula','node','nook',
        // O
        'oak','oasis','ocean','ore','outpost',
        // P
        'paddle','palisade','pass','peak','pebble','pillar','plain','plateau','plunge',
        'point','pond','pool','port','prairie',
        // Q
        'quarry','quartz',
        // R
        'range','rapid','ravine','reef','ridge','rim','rise','river','rock','root','rune',
        // S
        'sand','scope','sea','seam','shelf','shield','shore','shrub','sierra','silt',
        'sky','slab','slope','soil','sound','spring','spire','stone','strand','strait','stream','summit','surge',
        // T
        'tide','tarn','terrace','timber','tor','trail','trench','tundra',
        // V
        'vale','valley','vault','veil','vent','vista',
        // W
        'wake','wave','wharf','wild','wind','wisp','wood',
        // Y
        'yew',
    ];

    /**
     * Generate a random `adjective-color-noun` slug.
     *
     * Draws one word from each curated list and joins them with hyphens.
     * Every call is independently random with no internal state.
     *
     * @returns A slug such as `"steadfast-cobalt-ridge"`.
     */
    static generate(): string {
        return [
            SlugFactory._pick(SlugFactory.ADJECTIVES),
            SlugFactory._pick(SlugFactory.COLORS),
            SlugFactory._pick(SlugFactory.NOUNS),
        ].join('-');
    }

    /**
     * Return a uniformly random element from `arr`.
     * Caller guarantees `arr` is non-empty.
     */
    private static _pick<T>(arr: readonly T[]): T {
        return arr[Math.floor(Math.random() * arr.length)]!;
    }
}
