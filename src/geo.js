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
