import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useDeskStorage } from '../../lib/useDeskStorage'
import { Icon, type IconName } from '../Icon'

type Place = {
  name: string
  country?: string
  latitude: number
  longitude: number
}

type CurrentWeather = {
  temperature: number
  humidity: number
  wind: number
  code: number
  time: string
}

type Props = {
  resourceId: string
  defaultCity?: string
  defaultLat?: number
  defaultLon?: number
}

type StoredPlace = Place

const PLACE_KEY = 'known.desk.weather.place.v1'

function normalizePlace(stored: unknown): Place | null {
  const parsed = stored as StoredPlace
  if (
    typeof parsed?.name === 'string' &&
    typeof parsed?.latitude === 'number' &&
    typeof parsed?.longitude === 'number'
  ) {
    return parsed
  }
  return null
}

/** WMO weather interpretation codes → short label */
function weatherLabel(code: number): string {
  if (code === 0) return 'Clear'
  if (code === 1) return 'Mainly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code >= 85 && code <= 86) return 'Snow showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Mixed'
}

function weatherGlyph(code: number): IconName {
  if (code === 0 || code === 1) return 'sun'
  if (code === 2) return 'cloud-sun'
  if (code === 3) return 'cloud'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'rain'
  if (code >= 85 && code <= 86) return 'snow'
  if (code >= 95) return 'storm'
  return 'cloud'
}

export function WeatherWidget({
  resourceId,
  defaultCity = 'Beijing',
  defaultLat = 39.9042,
  defaultLon = 116.4074,
}: Props) {
  const { value: place, set: setPlace } = useDeskStorage<Place>({
    storageKey: PLACE_KEY,
    fallback: () => ({
      name: defaultCity,
      latitude: defaultLat,
      longitude: defaultLon,
    }),
    normalize: normalizePlace,
  })
  const [current, setCurrent] = useState<CurrentWeather | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)

  const fetchWeather = useCallback(async (p: Place, signal?: AbortSignal) => {
    setStatus('loading')
    setErrorMsg(null)
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${p.latitude}&longitude=${p.longitude}` +
        `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&timezone=auto`
      const res = await fetch(url, { signal })
      if (!res.ok) throw new Error('Weather request failed')
      const data = (await res.json()) as {
        current?: {
          temperature_2m?: number
          relative_humidity_2m?: number
          weather_code?: number
          wind_speed_10m?: number
          time?: string
        }
      }
      const c = data.current
      if (!c || c.temperature_2m == null) throw new Error('No current data')
      setCurrent({
        temperature: Math.round(c.temperature_2m),
        humidity: Math.round(c.relative_humidity_2m ?? 0),
        wind: Math.round(c.wind_speed_10m ?? 0),
        code: c.weather_code ?? 0,
        time: c.time ?? '',
      })
      setStatus('idle')
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setStatus('error')
      setErrorMsg("Couldn't load weather")
      setCurrent(null)
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    void fetchWeather(place, ctrl.signal)
    return () => ctrl.abort()
  }, [place, fetchWeather])

  const applyPlace = (next: Place) => {
    setPlace(next)
    setEditing(false)
    setQuery('')
  }

  const searchCity = async (e: FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setStatus('loading')
    setErrorMsg(null)
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`,
      )
      if (!res.ok) throw new Error('Geocode failed')
      const data = (await res.json()) as {
        results?: Array<{
          name: string
          country?: string
          latitude: number
          longitude: number
        }>
      }
      const hit = data.results?.[0]
      if (!hit) {
        setStatus('error')
        setErrorMsg('City not found')
        return
      }
      applyPlace({
        name: hit.name,
        country: hit.country,
        latitude: hit.latitude,
        longitude: hit.longitude,
      })
    } catch {
      setStatus('error')
      setErrorMsg('Lookup failed')
    }
  }

  const useLocation = () => {
    if (!navigator.geolocation) {
      setErrorMsg('Geolocation unavailable')
      setStatus('error')
      return
    }
    setStatus('loading')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        applyPlace({
          name: 'Near you',
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        })
      },
      () => {
        setStatus('error')
        setErrorMsg('Location denied')
      },
      { enableHighAccuracy: false, timeout: 8000 },
    )
  }

  return (
    <div className="desk-widget" data-resource={resourceId}>
      <div className="desk-weather-top">
        <button
          type="button"
          className="desk-weather-place"
          onClick={() => setEditing((v) => !v)}
          title="Change city"
        >
          <span className="desk-weather-city">{place.name}</span>
          {place.country && <span className="meta">{place.country}</span>}
        </button>
        <button
          type="button"
          className="desk-weather-refresh meta"
          onClick={() => void fetchWeather(place)}
          disabled={status === 'loading'}
        >
          {status === 'loading' ? '…' : 'Refresh'}
        </button>
      </div>

      {editing && (
        <form className="desk-weather-edit" onSubmit={searchCity}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="City name…"
            aria-label="City search"
            autoFocus
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!query.trim()}>
            Set
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={useLocation}>
            Near me
          </button>
        </form>
      )}

      {status === 'error' && errorMsg && !current && (
        <p className="desk-weather-error meta">{errorMsg}</p>
      )}

      {current ? (
        <div className="desk-weather-body">
          <div className="desk-weather-main">
            <span className="desk-weather-glyph" aria-hidden>
              <Icon name={weatherGlyph(current.code)} />
            </span>
            <strong className="desk-weather-temp">{current.temperature}°</strong>
            <span className="desk-weather-label">{weatherLabel(current.code)}</span>
          </div>
          <div className="desk-weather-meta">
            <span>Humidity {current.humidity}%</span>
            <span>Wind {current.wind} km/h</span>
          </div>
        </div>
      ) : (
        status === 'loading' && <p className="desk-weather-loading meta">Loading conditions…</p>
      )}
    </div>
  )
}
