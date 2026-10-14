# Documentation

## Overview

This documentation covers the core features and usage of the sample project.

## Installation

```bash
npm install sample-project
```

## API Reference

### `create(options)`

Creates a new instance with the given options.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `name` | string | `''` | Application name |
| `debug` | boolean | `false` | Enable debug mode |
| `port` | number | `3000` | Server port |

**Returns:** `Instance`

### `instance.start()`

Starts the application server.

**Returns:** `Promise<void>`

## Examples

```javascript
const app = create({ name: 'My App', port: 8080 });
await app.start();
```
