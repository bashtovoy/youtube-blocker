/* lexicon-data.js — kuratierte Startmatrix (25 Konzepte).
   Die Varianten decken die 54 Wörter des bisherigen Nutzer-Exports ab und
   ergänzen explizite Schreibweisen/Formen. Kein Fuzzy-Matching: Was hier
   nicht steht, trifft auch nicht. Wird nur für die Migration des alten
   flachen `keywords`-Arrays und für neue Installationen geladen; der
   Content-Script braucht diese Datei nicht. */
(function () {
  'use strict';

  const groups = [
    {
      id: 'drones',
      label: 'Дроны',
      route: 'auto',
      prompt: 'a drone flying in the sky',
      variants: [
        'Дрон', 'Drone', 'Dron', 'drontech', 'UAV', 'drones', 'dji', 'vtol',
        'дрона', 'дроны', 'дронов', 'дроне', 'дроном', 'дронах', 'дрони', 'дронів',
        'dhrone', 'drohne', 'drohnen', 'БПЛА', 'беспилотник', 'беспилотники',
        'беспилотников', 'беспилотный аппарат', 'дрон-камикадзе', 'fpv', 'uavs',
        'shahed', 'шахед', 'bayraktar', 'байрактар', 'mavic', 'quadcopter',
        'квадрокоптер', 'квадрокоптеры'
      ],
      exceptions: []
    },
    {
      id: 'robots',
      label: 'Роботы',
      route: 'auto',
      prompt: 'a robot',
      variants: [
        'Робот', 'Robot', 'robotics', 'humanoid', 'roboter', 'robots',
        'робота', 'роботы', 'роботов', 'роботу', 'роботом', 'роботах',
        'робототехника', 'робототехники', 'роботизация', 'гуманоид', 'гуманоиды',
        'robotik', 'humanoids', 'humanoid robot', 'киборг', 'cyborg',
        'exoskeleton', 'экзоскелет'
      ],
      exceptions: [
        'теннис', 'настольный теннис', 'пинг-понг', 'пинг понг',
        'tennis', 'table tennis', 'ping pong', 'теніс', 'настільний теніс'
      ]
    },
    {
      id: 'trump',
      label: 'Трамп',
      route: 'auto',
      prompt: 'donald trump',
      variants: [
        'Трамп', 'Trump', 'трампа', 'трампу', 'трампом', 'трампе',
        'trumps', 'donald trump', 'дональд трамп'
      ],
      exceptions: []
    },
    {
      id: 'putin',
      label: 'Путин',
      route: 'auto',
      prompt: 'vladimir putin',
      variants: [
        'Putin', 'путин', 'путина', 'путину', 'путиным', 'путине',
        'putins', 'vladimir putin', 'владимир путин'
      ],
      exceptions: []
    },
    {
      id: 'musk',
      label: 'Илон Маск',
      route: 'auto',
      prompt: 'elon musk',
      variants: [
        'elon musk', 'илон маск', 'илона маска', 'илону маску',
        'илоном маском', 'маск', 'musk', 'elon', 'илон', 'spacex',
        'space x', 'нейролинк', 'neuralink'
      ],
      exceptions: []
    },
    {
      id: 'tesla',
      label: 'Tesla',
      route: 'auto',
      prompt: 'a tesla electric car',
      variants: [
        'Тесла', 'Tesla', 'cybercab', 'roadster', 'теслы', 'тесле', 'теслу',
        'teslas', 'cybertruck', 'tesla model 3', 'tesla model y',
        'tesla model s', 'tesla model x'
      ],
      exceptions: ['no tesla']
    },
    {
      id: 'leaks',
      label: 'Утечки',
      route: 'text',
      prompt: 'a leaked confidential document',
      variants: [
        'leak', 'leaked', 'leaks', 'leaking', 'leaker', 'leakage',
        'утечка', 'утечки', 'утечек', 'утечке', 'утечку', 'утечка данных',
        'утечка информации', 'слив данных', 'слив базы', 'слив информации',
        'leaked data', 'data leak', 'database leak'
      ],
      exceptions: []
    },
    {
      id: 'news',
      label: 'Новости',
      route: 'text',
      prompt: 'a news studio',
      variants: [
        'news', 'breaking', 'новости', 'новость', 'новостей', 'новостям',
        'новостях', 'срочно', 'срочные новости', 'срочная новость',
        'breaking news', 'nachrichten', 'новини', 'новина', 'news update',
        'latest news'
      ],
      exceptions: ['breaking bad']
    },
    {
      id: 'military',
      label: 'Военные',
      route: 'auto',
      prompt: 'soldiers in military uniform',
      variants: [
        'militaire', 'military', 'военный', 'военные', 'военного', 'военным',
        'военных', 'военная', 'военной', 'военную', 'военнослужащий',
        'военнослужащие', 'военнослужащих', 'солдат', 'солдаты', 'солдатов',
        'soldier', 'soldiers', 'soldat', 'soldaten', 'army', 'армия', 'армии',
        'militär', 'militaer'
      ],
      exceptions: []
    },
    {
      id: 'war',
      label: 'Война',
      route: 'auto',
      prompt: 'a war scene with soldiers and smoke',
      variants: [
        'war', 'война', 'войны', 'войну', 'войной', 'войне', 'войн', 'wars',
        'warfare', 'krieg', 'kriege', 'війна', 'війни', 'війну', 'guerre',
        'guerra'
      ],
      exceptions: []
    },
    {
      id: 'navy',
      label: 'Флот',
      route: 'auto',
      prompt: 'a navy warship at sea',
      variants: [
        'Navy', 'naval', 'флот', 'флота', 'флоту', 'флотом', 'флоте', 'вмф',
        'военно-морской', 'flotte', 'warship', 'warships', 'военный корабль',
        'военные корабли', 'авианосец', 'авианосцы', 'submarine',
        'подводная лодка', 'подлодка'
      ],
      exceptions: []
    },
    {
      id: 'mil-aviation',
      label: 'Военная авиация',
      route: 'auto',
      prompt: 'a military fighter jet',
      variants: [
        'bombers', 'bomber', 'бомбардировщик', 'бомбардировщики',
        'бомбардировщиков', 'истребитель', 'истребители', 'fighter jet',
        'fighter jets', 'jet fighter', 'military aircraft', 'военная авиация',
        'военный самолет', 'боевой самолет', 'air force', 'ввс'
      ],
      exceptions: []
    },
    {
      id: 'ru-aviation',
      label: 'Российская авиация',
      route: 'auto',
      prompt: 'a russian passenger jet',
      variants: [
        'sukhoi', 'superjet', 'MS-21', 'су-57', 'су-35', 'су-34', 'су-30',
        'su-57', 'su-35', 'su-34', 'su-30', 'ssj-100', 'ssj100', 'мс-21',
        'ту-214', 'tu-214', 'ту-204', 'tu-204', 'ил-96', 'il-96'
      ],
      exceptions: []
    },
    {
      id: 'politics',
      label: 'Политика',
      route: 'text',
      prompt: 'politicians in a parliament',
      variants: [
        'Politics', 'CDU', 'AFD', 'политика', 'политики', 'политику',
        'политикой', 'политике', 'политик', 'политический', 'политические',
        'political', 'politik', 'politiker', 'spd', 'csu', 'bundestag',
        'бундестаг', 'парламент', 'parliament', 'канцлер', 'chancellor'
      ],
      exceptions: []
    },
    {
      id: 'russia',
      label: 'Россия',
      route: 'text',
      prompt: 'the kremlin',
      variants: [
        'russia', 'russian', 'россия', 'россии', 'россию', 'россией',
        'российский', 'российские', 'российская', 'рф', 'кремль', 'кремля',
        'kremlin', 'moscow', 'москва', 'москвы'
      ],
      exceptions: []
    },
    {
      id: 'china',
      label: 'Китай',
      route: 'text',
      prompt: 'beijing city skyline',
      variants: [
        'china', 'chinese', 'китай', 'китая', 'китаю', 'китаем', 'китае',
        'китайский', 'китайская', 'китайские', 'кнр', 'beijing', 'пекин',
        'пекина', 'shanghai', 'шанхай', 'xi jinping', 'си цзиньпин'
      ],
      exceptions: []
    },
    {
      id: 'scandal',
      label: 'Скандал',
      route: 'text',
      prompt: 'a scandalous news headline',
      variants: [
        'scandal', 'skandal', 'scandals', 'скандал', 'скандалы', 'скандала',
        'скандалов', 'скандальный', 'скандальная', 'скандальное', 'skandale',
        'skandals'
      ],
      exceptions: []
    },
    {
      id: 'hackers',
      label: 'Хакеры',
      route: 'text',
      prompt: 'a hacker at a computer',
      variants: [
        'hacker', 'hackers', 'hacking', 'hacked', 'hack', 'хакер', 'хакеры',
        'хакеров', 'хакера', 'хакерский', 'хакерская', 'взлом', 'взлома',
        'взломали', 'кибератака', 'кибератаки', 'cyberattack', 'cyber attack',
        'data breach', 'malware', 'ransomware', 'шифровальщик'
      ],
      exceptions: []
    },
    {
      id: 'shock',
      label: 'Шок',
      route: 'auto',
      prompt: 'a person with a shocked facial expression',
      variants: [
        'shocked', 'shook', 'shocking', 'шок', 'шока', 'шокирующий',
        'шокирующая', 'шокирующее', 'шокирован', 'шокированы', 'jaw-dropping',
        'unbelievable', 'шокирующие кадры', 'shocking footage'
      ],
      exceptions: []
    },
    {
      id: 'death',
      label: 'Смерть',
      route: 'auto',
      prompt: 'a funeral or a grave',
      variants: [
        'RIP', 'dead', 'killer', 'death', 'died', 'dies', 'dying', 'kill',
        'killed', 'killing', 'murder', 'murdered', 'corpse', 'funeral',
        'смерть', 'смерти', 'смертью', 'умер', 'умерла', 'умерли', 'умерший',
        'погиб', 'погибла', 'погибли', 'погибший', 'убийца', 'убийство',
        'убит', 'убиты', 'труп', 'похороны', 'кладбище', 'могила', 'катафалк'
      ],
      exceptions: ['kill bill']
    },
    {
      id: 'destruction',
      label: 'Разрушение',
      route: 'auto',
      prompt: 'destroyed buildings and rubble',
      variants: [
        'destroyed', 'destroying', 'destroy', 'destroys', 'destruction',
        'destructive', 'demolished', 'demolition', 'rubble', 'ruins', 'ruined',
        'разрушение', 'разрушения', 'разрушенный', 'разрушенные', 'разрушили',
        'уничтожен', 'уничтожено', 'уничтожены', 'уничтожение', 'руины', 'руин',
        'обломки', 'развалины'
      ],
      exceptions: []
    },
    {
      id: 'clickbait',
      label: 'Кликбейт',
      route: 'text',
      prompt: 'a clickbait youtube thumbnail',
      variants: [
        'gamechanger', 'game changer', 'change forever', 'changes forever',
        'changed forever', 'will change everything', 'изменит всё',
        'изменит навсегда', 'изменится навсегда', 'перевернёт мир',
        "you won't believe", "you won't believe this", 'must see', 'must watch',
        'сенсация', 'сенсационный', 'clickbait', 'click bait', 'viral',
        'вирусное видео'
      ],
      exceptions: []
    },
    {
      id: 'halloween',
      label: 'Хэллоуин',
      route: 'auto',
      prompt: 'halloween pumpkins and spooky decorations',
      variants: [
        'halloween', 'хэллоуин', 'хеллоуин', 'хэллоуина', 'хеллоуина',
        'halloween night', 'spooky', 'trick or treat', 'jack-o-lantern',
        'halloween pumpkin'
      ],
      exceptions: []
    },
    {
      id: 'brad-pitt',
      label: 'Брэд Питт',
      route: 'auto',
      prompt: 'brad pitt',
      variants: [
        'Brad Pit', 'brad pitt', 'брэд питт', 'брад питт', 'брэда питта',
        'брэду питту', 'brad pitt movie', 'брэд питт фильм'
      ],
      exceptions: []
    },
    {
      id: 'vr',
      label: 'VR',
      route: 'auto',
      prompt: 'a person wearing a vr headset',
      variants: [
        'VR', 'virtual reality', 'виртуальная реальность',
        'виртуальной реальности', 'oculus', 'meta quest', 'quest 3', 'quest 2',
        'quest 3s', 'psvr', 'psvr2', 'valve index', 'htc vive', 'vive',
        'vr headset', 'vr очки', 'очки виртуальной реальности'
      ],
      exceptions: []
    }
  ];

  window.YB = window.YB || {};
  window.YB.lexiconData = { version: 1, groups };
})();
