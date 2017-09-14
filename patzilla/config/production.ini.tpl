###
# General application configuration
###

[ip_navigator]
datasources = ops, depatisconnect, ificlaims, depatech


[datasource_ops]

# Application-wide authentication credentials
api_consumer_key    = {ops_api_consumer_key}
api_consumer_secret = {ops_api_consumer_secret}

# 3.1.2. Fulltext inquiry and retrieval including description or claims
#        Note, Currently full texts (description and/or claims) are only available for the following
#        authorities: EP, WO, AT, CA (claims only), CH.
# -- http://documents.epo.org/projects/babylon/eponet.nsf/0/7AF8F1D2B36F3056C1257C04002E0AD6/$File/OPS_RWS_ReferenceGuide_version1210_EN.pdf
fulltext_enabled = true
fulltext_countries = EP, WO, AT, CH


[datasource_depatisconnect]

# Local development
#api_uri = http://localhost:20300

# Production
api_uri = {depatisconnect_api_uri}

# 2014-07-02: Add fulltexts for DE and US through DEPATISconnect
fulltext_enabled = true
fulltext_countries = DE, US


[datasource_ificlaims]

# API connection settings
api_uri      = {ificlaims_api_uri}
api_username = {ificlaims_api_username}
api_password = {ificlaims_api_password}

# 2017-03-09: Add fulltexts for more countries through IFI Claims
fulltext_enabled = true
fulltext_countries = BE, CA, CN, FR, GB, IN, JP, KR, LU, NL, RU
# Not enabled yet: EA, SI, ES, IN, AU, HK, BR, PL, CZ, IT, NZ, HU, TR, DK, HR, YU, RS, PT, UA, ZA, SE, MX, NO, BG, SK, TW, AR, GR, ID, IL, FI, DD, CS, MC

details_enabled = true
details_countries = CN, IN, KR


[datasource_depatech]

# API connection settings
api_uri      = {depatech_api_uri}
api_username = {depatech_api_username}
api_password = {depatech_api_password}



[smtp]
# smtp host information
hostname = {smtp_hostname}
port     = 587              ; smtp submission port, default: 25
tls      = true             ; use TLS, default: true
username = {smtp_username}
password = {smtp_password}

[email]
# Sender addresses "From" and "Reply-To"
from      = IP Navigator <navigator-system@example.org>
reply     = IP Navigator Support <navigator-support@example.org>

# Email content defaults
subject-prefix = [ip-navigator]
body-template =
    Sehr geehrter Kunde,
    \n
    vielen Dank für Ihre Nachricht!
    \n
    Diese E-Mail wurde aufgrund Ihrer Mitteilung automatisch von unserem Trackingsystem generiert,
    wir werden Ihre Anfrage so schnell wie möglich beantworten.
    \n
    Bitte kommen Sie sonst telefonisch auf uns zu, unsere Telefonnummer finden Sie in der E-Mail Signatur.
    \n
    Mit freundlichen Grüßen,
    Ihr IP Navigator Support Team.
    \n
    ----
    \n
    Message:
    {{ message }}
    \n

    {% if details: %}
    Details: {{ details }}
    \n
    {% endif %}

    {% if filenames: %}
    Im Anhang finden Sie weitere technische Details zu Ihrer Anfrage aus dem Systemkontext:
    {{ filenames }}
    \n
    {% endif %}

signature =
    ACME Inc.
    Way 42
    12345 Universe

    Email: info@example.org
    Web: https://example.org

[email-recipients]

# Recipient addresses "To:"
support = IP Navigator Support <navigator-support@example.org>
system  = IP Navigator System <navigator-system@example.org>


###
# Pyramid application configuration
# http://docs.pylonsproject.org/projects/pyramid/en/latest/narr/environment.html
###

[filter:prefix-middleware]
use = egg:PasteDeploy#prefix

[app:main]
use = egg:PatZilla
filter-with = prefix-middleware


pyramid.reload_templates = false
pyramid.debug_authorization = false
pyramid.debug_notfound = false
pyramid.debug_routematch = false
pyramid.default_locale_name = en
pyramid.includes =

# cache settings
cache.regions = search, medium, longer, static
cache.url = mongodb://localhost:27017/beaker.cache
cache.key_length = 512

cache.search.type = ext:mongodb
cache.search.sparse_collection = true

cache.medium.type = mongodb_gridfs
cache.medium.sparse_collection = true
cache.longer.type = mongodb_gridfs
cache.longer.sparse_collection = true
cache.static.type = mongodb_gridfs
cache.static.sparse_collection = true

# 1 hour
#cache.search.expire = 3600
# 2 hours
cache.search.expire = 7200
# 6 hours
#cache.search.expire = 21600

# medium: 1 day
cache.medium.expire = 86400

# longer: 1 week
cache.longer.expire = 604800

# static: 1 month
cache.static.expire = 2592000


# database configuration
mongodb.ipsuite.uri = mongodb://localhost:27017/ipsuite

# app settings
ipsuite.production = true


[server:main]
use = egg:waitress#main
host = 0.0.0.0
port = 9999

###
# logging configuration
# http://docs.pylonsproject.org/projects/pyramid/en/latest/narr/logging.html
###

[loggers]
keys = root, sqlalchemy, patzilla

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = INFO
handlers = console

[logger_patzilla]
level = WARN
handlers =
qualname = patzilla

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine
# "level = INFO" logs SQL queries.
# "level = DEBUG" logs SQL queries and results.
# "level = WARN" logs neither.  (Recommended for production systems.)

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(asctime)s %(levelname)-5.5s [%(name)s][%(threadName)s] %(message)s