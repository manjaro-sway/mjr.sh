/**
 * List of domains that are _not_ purged after the cutOff date.
 */
const allowList = [
	"github.com",
	"gitlab.com",
	"google.com",
	"google.de",
	"heise.de",
	"manjaro.org",
	"manjaro.download",
	"manjaro-sway.download",
	"githubusercontent.com",
	"youtube.com",
];

const cutOffDays = 14;
/**
 * SQLite's `current_timestamp` writes `YYYY-MM-DD HH:MM:SS`, so the cutoff has
 * to use the same shape for the string comparison in the purge to be correct.
 */
export const getCutoffDate = () => {
	const cutOff = new Date(Date.now() - 1000 * 60 * 60 * 24 * cutOffDays);

	return cutOff.toISOString().replace("T", " ").slice(0, 19);
};

export default allowList;
