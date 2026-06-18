"""Config flow for Room Intercom — single instance, optional HTTPS tuning."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_ENABLE_HTTPS,
    CONF_PROXY_PORT,
    CONF_SPEAKERS,
    DEFAULT_ENABLE_HTTPS,
    DEFAULT_PROXY_PORT,
    DOMAIN,
)


class RoomIntercomConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-step setup: nothing required, everything is runtime."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title="Room Intercom", data={})
        return self.async_show_form(step_id="user")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> "RoomIntercomOptionsFlow":
        return RoomIntercomOptionsFlow()


class RoomIntercomOptionsFlow(OptionsFlow):
    """Let the user toggle the built-in HTTPS proxy and its port."""

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        opts = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_SPEAKERS,
                    default=opts.get(CONF_SPEAKERS, []),
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain="media_player", multiple=True
                    )
                ),
                vol.Required(
                    CONF_ENABLE_HTTPS,
                    default=opts.get(CONF_ENABLE_HTTPS, DEFAULT_ENABLE_HTTPS),
                ): bool,
                vol.Required(
                    CONF_PROXY_PORT,
                    default=opts.get(CONF_PROXY_PORT, DEFAULT_PROXY_PORT),
                ): vol.All(int, vol.Range(min=1, max=65535)),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
