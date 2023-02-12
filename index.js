const Kong = require('@tropos/kong-admin-api-client');

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.kong = null;

    this.hooks = {
      'after:deploy:deploy': this.afterDeployFunctions.bind(this),
    };
  }

  /**
   * @description hook to after deployment
   *
   * @return {Promise}
   */

  async afterDeployFunctions() {
    this.stage = this.serverless.service.provider.stage || 'dev';
    this.region = this.serverless.service.provider.region || 'us-east-1';
    this.providerName = this.serverless.service.provider.name;

    const defaultConfig = (this.serverless.config.serverless.service.custom || {}).kong || {};
    const defaultLambdaConfig = (defaultConfig.lambda || {}).config || {};
    const defaultVirtualService = defaultConfig.virtual_service || {};
    const detaultBasePath = defaultVirtualService.base_path || '';
    const detaultTags = defaultConfig.tags;

    this.kong = new Kong({ adminAPIURL: defaultConfig.admin_api_url || 'http://localhost:8001' });

    // Create a Virtual Service for Lambda Functions
    const serviceName = defaultVirtualService.name || this.serverless.configurationInput.service
    const serviceUrl = defaultVirtualService.url || 'http://localhost:8000'
    const service = await this.createVirtualService(serviceName, serviceUrl, detaultTags)

    // get the current routes in Kong
    const existingRoutes = [];
    const newRoutes = [];
    let next = null;
    do {
      const result = await this.listRoutes(serviceName);
      existingRoutes.push(...result.data);
      next = result.next; // eslint-disable-line
    } while (next !== null);

    const functions = Object.keys(this.serverless.service.functions)
      .map(key => this.serverless.service.functions[key]);

    for (const f of functions) {
      const kongEvents = f.events.filter(e => e.kong !== undefined).map(x => x.kong);

      for (const event of kongEvents) {
        // create route and add the aws-lambda plugin
        const routeConfig = this.constructRouteConfig(event, detaultBasePath, detaultTags)
        const route = await this.createRoute(service, routeConfig);

        const lambdaConfig = this.constructLambdaConfig(event, defaultLambdaConfig, f)
        await this.addLambdaPlugin(route, lambdaConfig, detaultTags);

        // add any other specified plugins
        const plugins = event.plugins || [];
        for (const plugin of plugins) {
          await this.addPluginToRoute(route, plugin, detaultTags);
        }
        // add name to new routes (it's importante to add this names on kong routes only after delete old routes to avoid conflit )
        route.name = f.name
        newRoutes.push(route)
      }
    }

    await this.deleteOldRoutes(existingRoutes)

    await this.updateAllNewRoutesNames(newRoutes)

  }

  createVirtualService(name, url, tags) {
    return this.kong.services.createOrUpdate(name, {
      url: url,
      tags: tags
    });
  }

  constructLambdaConfig(event, defaultLambdaConfig, f) {
    const eventLambdaConfig = (event.lambda || {}).config || {};
    const lambdaConfig = Object.assign(
      {},
      { aws_region: this.region, function_name: f.name },
      defaultLambdaConfig,
      eventLambdaConfig,
    );
    return lambdaConfig
  }

  constructRouteConfig(event, detaultBasePath, detaultTags) {
    let routeConfig = this.addBasePathToRoute(event.route, detaultBasePath)
    routeConfig = this.addTagsToRoute(event.route, detaultTags)
    return routeConfig
  }

  createRoute(service, route) {
    return this.kong.routes.create({
      service: { id: service.id },
      ...route,
    });
  }

  addLambdaPlugin(route, config, tags) {
    return this.kong.routes.addPlugin({
      routeId: route.id,
      name: 'aws-lambda',
      config,
      tags: tags,
      enabled: true,
    });
  }

  addPluginToRoute(route, plugin, tags) {
    plugin.tags = tags;
    return this.kong.routes.addPlugin({
      routeId: route.id,
      ...plugin,
    });
  }

  updateRouteName(route, routeName) {
    return this.kong.routes.update(
      route.id,
      {name: routeName},
    );
  }

  listRoutes(serviceName) {
    return this.kong.routes.list({ serviceNameOrID: serviceName });
  }

  addBasePathToRoute(route, basePath) {
    const newPaths = [];
    for (const path of route.paths) {
      newPaths.push(basePath + path)
    }
    route.paths = newPaths
    return route
  }

  addTagsToRoute(route, tags) {
    route.tags = tags
    return route
  }

  deleteOldRoutes(existingRoutes) {
    const parallelExecution = []
    for (const r of existingRoutes) {
      parallelExecution.push(this.kong.routes.delete(r.id));
    }
    return Promise.all(parallelExecution)
  }

  updateAllNewRoutesNames(newRoutes) {
    const parallelExecution = []
    for (const newRoute of newRoutes) {
      parallelExecution.push(this.updateRouteName(newRoute, newRoute.name))
    }
    return Promise.all(parallelExecution)
  }

}

module.exports = ServerlessPlugin;
