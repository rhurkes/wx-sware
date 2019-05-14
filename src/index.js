const api_base = 'https://sigtor.org/v1/events';
const poll_delay_ms = 60 * 1000;
const minute_in_us = 1 * 60 * 1000 * 1000;
const hour_in_us = 60 * minute_in_us;
const day_in_us = 24 * hour_in_us;
const chase_mode_distance_miles = 120;
const event_retention_in_us = 3 * hour_in_us;
const ls_config_items_key = 'sware-config-items';
const ls_config_key = 'sware-config';
const sev_hail_threshold = 2.0;
const tor_related_hazards = ['Tornado', 'WallCloud', 'Funnel'];

// Alert blurbs
const tor_emergency_blurb = "The National Weather Service has issued a Tornado Emergency.";
const new_watch_blurb = "The Storm Prediction Center has issued a new $PDS $WATCHTYPE watch for $PLACE.";
const new_md_blurb = "The Storm Prediction Center has issued mesoscale discussion $NUMBER $PROBABILITY.";
const new_outlook_blurb = "The Storm Prediction Center has issued a new Day 1 outlook, $RISK.";
const sev_hail_blurb = "$MAG inch severe hail has been reported $PLACE.";
const tor_blurb = "A tornado has been reported $PLACE by $REPORTER.";
const tor_warning_blurb = "The National Weather Service has issued a $PDS Tornado Warning for: $PLACE";
const svs_blurb = "The National Weather Service has issued a PDS severe weather statement.";

let last_ts = 0;
let geo_location = {};

const toRad = x => (x * Math.PI) / 180;
// The values used for the radius of the Earth (3961 miles & 6373 km) are optimized for locations around 39 degrees from the equator
const R = 3961;

/**
 * Returns the distance in miles between two points
 * @param {*} current_location 
 * @param {*} point 
 */
const get_distance = (point1, point2) => {
    const l1Rad = toRad(point1.lat);
    const l2Rad = toRad(point2.lat);
    const dLat = toRad(point2.lat - point1.lat);
    const dLon = toRad(point2.lon - point1.lon);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(l1Rad) * Math.cos(l2Rad) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const d = R * c;
    return Math.floor(d);
}

const is_point_in_bounds = (point, bounds) => {
    return (point.lat >= bounds.min_lat && point.lat <= bounds.max_lat &&
        point.lon >= bounds.min_lon && point.lon <= bounds.max_lon);
}

const poly_to_bounds = (poly) => {
    let min_lat = poly[0].lat;
    let min_lon = poly[0].lon;
    let max_lat = poly[0].lat;
    let max_lon = poly[0].lon;

    poly.forEach(x => {
        if (x.lat < min_lat) {
            min_lat = x.lat;
        }
        if (x.lon > min_lon) {
            min_lon = x.lon;
        }
        if (x.lat > max_lat) {
            max_lat = x.lat;
        }
        if (x.lon < max_lon) {
            max_lon = x.lon;
        }
    });

    return {
        min_lat,
        min_lon,
        max_lat,
        max_lon,
    };
}

const fetchUrl = (url) => fetch(url)
  .then(function(response) {
    return response.json();
  })
  .then(function(responseJson) {
    const preparedEvents = responseJson.map(prepareEvent);
    const descendingEvents = preparedEvents.reverse();
    if (descendingEvents[0]) {
        last_ts = descendingEvents[0].ingest_ts;
        app.events = descendingEvents.concat(app.events);
    }
    processEvents();
  });

// GPS timer
const geo_options = {
    enableHighAccuracy: true,
    timeout: 5000,
    maximumAge: 0
};

function geo_success(pos) {
    geo_location = { lat: pos.coords.latitude, lon: pos.coords.longitude };
}

setInterval(() => {
    const manualConfig = app.config_items.find(x => x.id === 'gpsLocation').toggled;
    if (!manualConfig) {
        navigator.geolocation.getCurrentPosition(console.info, console.warn, geo_options);   
    }
}, 60000);

// Clock timer
setInterval(() => {
    app.clock = get_clock();
}, 1000);

const get_clock = () => {
    const dt = new Date();
    
    return `${pad_zero(dt.getUTCHours())}${pad_zero(dt.getUTCMinutes())}Z`;
}

const prepareEvent = (event) => {
    const derived = {};
    const then = new Date(event.event_ts / 1000);
    const parsed_dt = `${pad_zero(then.getUTCHours())}${pad_zero(then.getUTCMinutes())}Z`;

    derived.is_important = get_importance(event);
    derived.is_tor_related = is_tor_related(event);
    derived.parsed_dt = parsed_dt;
    derived.link = get_link(event);

    if (event.location && event.location.poly) {
        const bounds = poly_to_bounds(event.location.poly);
        derived.point = get_center_simple(event.location.poly);
        derived.bounds = bounds;

        // Half of the diagonal is as close to a "radius" as we're likely to get in an easy way
        const half_edge_distance = get_distance(
            { lat: bounds.min_lat, lon: bounds.min_lon },
            { lat: bounds.max_lat, lon: bounds.max_lon }
        ) / 2;

        derived.half_edge_distance = half_edge_distance;
    }
    
    event.derived = derived;

    return event;
}

const get_link = event => {
    if (event.event_type === 'NwsSel') {
        let id = `${event.watch.id}`;

        if (id.length === 1) {
            id = `000${id}`;
        } else if (id.length === 2) {
            id = `00${id}`;
        } else if (id.length === 3) {
            id = `0${id}`;
        }
        
        return `https://www.spc.noaa.gov/products/watch/ww${id}.html`;
    } else if (event.event_type === 'NwsSwo' && event.md) {
        let id = `${event.md.id}`;
        let year = (new Date(event.event_ts / 1000)).getUTCFullYear()

        if (id.length === 1) {
            id = `000${id}`;
        } else if (id.length === 2) {
            id = `00${id}`;
        } else if (id.length === 3) {
            id = `0${id}`;
        }
        
        return `https://www.spc.noaa.gov/products/md/${year}/md${id}.html`;
    }

    return;
}

const filterEvent = (event, current_location) => {
    // Distance filter
    const is_chase_mode = app.config_items.find(x => x.id === 'chaseMode').toggled;

    if (is_chase_mode) {
        if (event.location && event.location.point) {
            const distance = get_distance(current_location, event.location.point);
            if (distance > chase_mode_distance_miles) {
                return false;
            }
        } else if (event.derived.point && event.derived.half_edge_distance) {
            const distance = get_distance(current_location, event.derived.point);
            if (distance > chase_mode_distance_miles + event.derived.half_edge_distance) {
                return false;
            }
        }
    }

    // Other filters
    const filter_afds = app.config_items.find(x => x.id === 'hideAfds').toggled;
    if (filter_afds && event.event_type === 'NwsAfd') {
        return false;
    }

    return true;
}

const massageEvent = (event, current_location) => {
    const now = Date.now() * 1000;  // Convert from ms to us
    event.derived.time_ago = get_time_ago(now, event.ingest_ts);

    // Conditional derivations
    if (current_location && event.location && event.location.point) {
        const distance = get_distance(current_location, event.location.point);
        event.derived.distance = `${distance}mi`;   
    }

    return event;
};

const is_tor_related = (event) => {
    if (event.report && tor_related_hazards.indexOf(event.report.hazard) > -1) {
        return true;
    } else if (event.event_type === 'NwsTor') {
        return true;
    } else if (event.event_type === 'NwsSvs') {
        return true;
    } else if (event.event_type === 'NwsSel' && event.watch && event.watch.watch_type === 'Tornado') {
        return true;
    }

    return false;
}

const get_current_location = () => {
    const manualConfig = app.config_items.find(x => x.id === 'gpsLocation');
    if (manualConfig.toggled && !isNaN(app.config.manualLat) && !isNaN(app.config.manualLon)) {
        return { lat: app.config.manualLat, lon: app.config.manualLon };
    }
}

const buildAlertForEvent = (event) => {
    let use_eas = false;

    if (event.seen) {
        return event;
    } else {
        event.seen = true;
    }

    let alert;

    if (event.report) {
        if (event.report.hazard === 'Tornado') {
            alert = tor_blurb.replace('$REPORTER', event.report.reporter)
            // SN won't have this, but LSRs will
            if (event.location.county) {
                alert = alert.replace('$PLACE', `for ${event.location.county} county.`);
            }
            if (event.report.is_tor_emergency) {
                alert += tor_emergency_blurb;
            }
        } else if (event.report.hazard === 'Hail' && event.report.magnitude && event.report.magnitude >= sev_hail_threshold) {
            alert = sev_hail_blurb
                .replace('$MAG', event.report.magnitude)
                .replace('$PLACE', event.location.county
                    ? `for ${event.location.county} county.`
                    : '');
        }
    } else if (event.outlook && event.outlook.swo_type === 'Day1') {
        alert = new_outlook_blurb.replace('$RISK', getRiskWords(event.outlook.max_risk));
    } else if (event.md && event.md.concerning.indexOf('New') === 0) {
        probability = event.md.watch_issuance_probability
            ? `with ${event.md.watch_issuance_probability}% watch chance`
            : '';
        alert = new_md_blurb
            .replace('$NUMBER', event.md.id)
            .replace('$PROBABILITY', probability);
    } else if (event.event_type === 'NwsTor') {
        alert = tor_warning_blurb
            .replace('$PLACE', event.warning.issued_for)
            .replace('$PDS', event.warning.is_pds ? 'PDS' : '');
    } else if (event.watch && event.watch.status === 'Issued') {
        use_eas = true;
        alert = new_watch_blurb
            .replace('$PDS', event.watch.is_pds ? 'PDS' : '')
            .replace('$WATCHTYPE', event.watch.watch_type)
            .replace('$PLACE', event.watch.issued_for);
    } else if (event.event_type === 'NwsSvs') {
        use_eas = true;
        alert = svs_blurb;
    }

    if (alert) {
        if (use_eas) {
            queueAlert('eas');
        }

        queueAlert(alert);
    }

    return event;
}

function getRiskWords(risk) {
    switch (risk) {
        case 'MRGL':
            return 'there is a Marginal Risk of severe thunderstorms';
        case 'SLGT':
            return 'there is a Slight Risk of severe thunderstorms';
        case 'ENH':
            return 'there is an Enhanced Risk of severe thunderstorms';
        case 'MDT':
            return 'there is a Moderate Risk of severe thunderstorms';
        case 'HIGH':
            return 'there is a High Risk of severe thunderstorms';
        default:
            return '';
    }
}

const processEvents = () => {
    const current_location = get_current_location();
    const alertedEvents = app.events.map(buildAlertForEvent);
    const truncatedEvents = truncateEvents(alertedEvents);
    app.events = truncatedEvents.map(x => massageEvent(x, current_location));
    app.displayEvents = app.events.filter(x => filterEvent(x, current_location));
}

const truncateEvents = (events) => {
    const now = Date.now() * 1000;  // ms to us
    const retention_cutoff = now - event_retention_in_us;
    let truncate_at_index = null;

    for (let i = 0; i < events.length; i++) {
        if (events[i].ingest_ts < retention_cutoff) {
            truncate_at_index = i;
            break;
        }
    }

    return (truncate_at_index !== null)
        ? events.slice(0, truncate_at_index)
        : events;
}

const get_importance = (event) => {
    let is_important = false;

    if (event.event_type === 'NwsSwo') {
        if (event.md && event.md.concerning.indexOf('New') === 0) {
            is_important = true;
        } else if (event.outlook && event.outlook.swo_type === 'Day1') {
            is_important = true;
        }
    } else if (event.event_type === 'SnReport' || event.event_type === 'NwsLsr') {
        if (event.report.hazard === 'Tornado' || event.report.hazard === 'WallCloud') {
            is_important = true;
        }
        if (event.report.hazard === 'Hail' && event.report.magnitude && event.report.magnitude > sev_hail_threshold) {
            is_important = true;
        }
    } else if (event.event_type === 'NwsTor') {
        is_important = true;
    } else if (event.event_type === 'NwsSel' && event.watch && event.watch.status === 'Issued') {
        is_important = true;
    }

    return is_important;
}

const get_time_ago = (now, then) => {
    const delta = now - then;
    if (delta < minute_in_us) {
        return '<1m';
    } else if (delta < hour_in_us) {
        return `${Math.floor(delta / minute_in_us)}m`;
    } else if (delta < day_in_us) {
        return `${Math.floor(delta / hour_in_us)}h`;
    } else {
        return '1d+'
    }
}

// TODO take places as 2nd param and update the decorate_text function
const pad_zero = (input) => {
    if (!isNaN(input)) {
        const num = parseInt(input);
        if (num < 10 && num > -1) {
            return `0${input}`;
        }
    }

    return input;
}

const save_config = () => {
    try {
        localStorage.setItem(ls_config_key, JSON.stringify(app.config));
        localStorage.setItem(ls_config_items_key, JSON.stringify(app.config_items));
    } catch (ex) {
        console.error(`Error saving config: ${ex}`);
    }
};
  
const load_config = () => {
    try {
        const config = localStorage.getItem(ls_config_key);
        const config_items = localStorage.getItem(ls_config_items_key);
        
        if (config) {
            app.config = JSON.parse(config);
        }

        if (config_items) {
            app.config_items = JSON.parse(config_items);
        }

        console.log('Loaded config.');
    } catch (ex) {
        console.error(`Error loading config: ${ex}`);
    }
};

/**
 * Does a simple and fast approximation of the center of a polygon. Do not use where
 * a precise centroid is required, especially for irregular polygons.
 */
const get_center_simple = (poly) => {
    let sum_lat = 0;
    let sum_lon = 0;

    poly.forEach(x => {
        sum_lat += x.lat;
        sum_lon += x.lon;
    });

    return {
        lat: sum_lat / poly.length,
        lon: sum_lon / poly.length,
    };
}

const app = new Vue({
    el: '#app',
    data: {
        events: [],
        displayEvents: [],
        config_items: [
            { id: "gpsLocation", text: "Manual GPS Location", toggled: false },
            { id: "hideAfds", text: "Hide AFDs", toggled: false },
            { id: "chaseMode", text: "Chase Mode", toggled: false },
            { id: "audioAlerts", text: "Audio Alerts", toggled: true },
        ],
        config: {
            'manualLat': null,
            'manualLon': null,
        },
        clock: get_clock(),
        details_source: '',
        details_text: '',
        details_link: '',
        details_time: '',
        sidebar_active: false,
    },
    methods: {
        showEventDetails: function(event) {
            app.events.forEach(x => { x.derived.selected = false; } );
            event.derived.selected = true;
            this.details_source = `Source: ${event.event_type}`; // TODO get source from eventtype
            if (event.event_type === 'NwsAfd' && !event.text && event.ext_uri) {
                fetch(event.ext_uri).then(x => x.json()).then(x => {
                    if (x && x.productText) {
                        event.text1 = x.productText;
                        this.details_text = x.productText;
                    }
                });
            }
            this.details_text = event.text;
            this.details_link = event.derived.link;
            this.details_time = `Time: ${event.derived.parsed_dt}`;
        },
        toggleConfig: function(id) {
            const item = this.config_items.find(x => x.id === id);
            item.toggled = !item.toggled;
        },
        toggleSidebar: function() {
            this.sidebar_active = !this.sidebar_active;

            if (!this.sidebar_active) {
                save_config();
                processEvents();
            }
        }
    }
});

const legalese = 'sware is not to be used while driving and shall not be used to guarantee one\'s safety.\n\nIt is alpha software - use at your own risk!';
if (confirm(legalese)) {
    load_config();
    let url = `${api_base}/${last_ts}`;
    fetchUrl(url);

    setInterval(() => {
        let url = `${api_base}/${last_ts}`;
        fetchUrl(url);
    }, poll_delay_ms);
}

// Audio
const audioElement = document.createElement('audio');
const synth = window.speechSynthesis;
const alert_config = app.config_items.find(x => x.id === 'audioAlerts');
let audioQueue = [];
let processing = false;

function processQueue() {
    processing = true;
    const queueItem = audioQueue[0];
  
    const queueCleanup = () => {
      if (audioQueue.length <= 1) {
        audioQueue = [];
        processing = false;
      } else {
        audioQueue = audioQueue.slice(1);
        setTimeout(processQueue, 2000);
      }
    };

    if (queueItem === 'eas') {
        audioElement.src = `assets/${queueItem}.mp3`;
        audioElement.onended = queueCleanup;
        audioElement.onerror = queueCleanup;
        audioElement.play();
    } else {
        queueItem.onend = queueCleanup;
        synth.speak(queueItem);
    }
  }

function queueAlert(text) {
    if (!synth || !alert_config.toggled || !text) { return; }
  
    if (text === 'eas') {
        audioQueue.push(text);
    } else {
        // Note: Chrome speech synth stops working after 15 second utterances
        // https://bugs.chromium.org/p/chromium/issues/detail?id=335907
        const utterance = new SpeechSynthesisUtterance(text);
    
        audioQueue.push(utterance);
    }
  
    if (!processing) {
        processQueue();
    }
}
