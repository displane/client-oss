const electron = require('electron');
const { app, BrowserWindow } = electron;
const request = require('request');
const fs = require('fs');
const pug = require('pug');
const si = require('systeminformation');
const tmp = require('tmp');
const os = require('os');
var exec = require('child_process').exec;
var schedule = require('node-schedule');

const express = require('express')
const webApp = express()
const port = 4568

var is_error = false;

var configuredCronJobs = []

var siteChecks = {}

var errorOccouredDuringStartup = false

var currentInterval

var activeConfigId

var baseURL = "https://app.displane.cloud"

var shouldAlwaysBeOnTop = true

var configFileName = process.env.CONFIG_FILE_NAME || "config.json"

var layoutDirectory = __dirname + "/layouts/";

if (process.env.DEBUG == "true") {
  var baseURL = "http://localhost:3000"
  var shouldAlwaysBeOnTop = false
}

var config = {
  playerId: null,
  sharedSecret: null
}

function reloadConfig() {
  if (fs.existsSync(configFileName)) {
    try {
      config = JSON.parse(fs.readFileSync(configFileName))
    } catch (e) {
      console.log("Broken config JSON")
      fs.unlinkFileSync(configFileName)
    }

  }

}

reloadConfig()

function executeJavaScriptInBrowser(browser, site) {
  for (js of site.js) {
    browser.webContents.executeJavaScript("document.getElementById('webview" + site.position + "').addEventListener('did-finish-load', () => {document.getElementById('webview" + site.position + "').executeJavaScript(atob('" + js.command + "'))});");

    browser.webContents.executeJavaScript("document.getElementById('webview" + site.position + "').addEventListener('did-frame-navigate', () => {document.getElementById('webview" + site.position + "').executeJavaScript(atob('" + js.command + "'))});");
  }
  if (process.env.DEBUG == "true") {
    browser.webContents.executeJavaScript("document.getElementById('webview" + site.position + "').openDevTools();")
  }
}

async function createCronsForSiteCheck(browser, site) {
  schedule.scheduleJob('* * * * *', async function () {
    try {
      var result = await browser.webContents.executeJavaScript(`document.getElementById('webview${site.position}').executeJavaScript('document.body.textContent.includes("${site.checkString}")');`)
      if (result == false) {
        siteChecks[site.id].failures++
        console.log("check " + site.id + " failures " + siteChecks[site.id].failures)
        await browser.webContents.executeJavaScript(`document.getElementById('webview${site.position}').reloadIgnoringCache();`)
      } else {
        siteChecks[site.id].failures = 0
      }
      console.log("Check " + result)
      
    } catch (error) {
      console.log(error)
      siteChecks[site.id].failures++
    }
    if (siteChecks[site.id].failures == 10) {
      closeAllOpenBrowserWindows()
      siteChecks[site.id].failures = 0
    }
  });
  siteChecks[site.id] = {
    failures: 0
  }
}

async function assignSites(screen, electronScreen) {
  var browser = new BrowserWindow({
    fullscreen: true,
    frame: false,
    x: electronScreen.bounds.x + 50,
    y: electronScreen.bounds.y + 50,
    alwaysOnTop: shouldAlwaysBeOnTop,
    webPreferences: {
      webviewTag: true,
      additionalArguments: [
        // "--remote-debugging-port=8315"
      ]
    }
  })
  try {
    const tmpobj = tmp.fileSync({ postfix: '.html' });
    var renderedHTML = pug.renderFile(layoutDirectory + 'layout' + screen.layout + '.pug', { main: screen.sites });
    fs.writeFileSync(tmpobj.name, renderedHTML)
    browser.loadURL('file://' + tmpobj.name);
    for (var site of screen.sites) {
      // setCookies(browser, parsedResponse[site]);
      executeJavaScriptInBrowser(browser, site);
      if (site.checkString) {
        createCronsForSiteCheck(browser, site)
      }
      
    }
  } catch (error) {
    displayErrorScreen("Unable to render HTML for page. Check you have enough sites added and refresh the config.", error, electronScreen)
    browser.destroy()
  }
}

function initializeScreens(playerConfig) {
  screenArray = electron.screen.getAllDisplays();

  for (const electronScreen of screenArray) {
    var screenAssigned = false
    try {
      for (const screen of playerConfig.screens) { // Otherwise just get and assign screens based on electronScreenId
        if (screen.electronScreenId == electronScreen.id) {
          assignSites(screen, electronScreen);
          screenAssigned = true
        }
      }
    } catch (err) {
      console.log(err)
      displayErrorScreen("Error in initilizing screens, please check your screen config.", err);
    }
    if (!screenAssigned) {
      var registerScreenData = {
        id: electronScreen.id,
        x: electronScreen.size.width,
        y: electronScreen.size.height,
        xpos: electronScreen.bounds.x,
        ypos: electronScreen.bounds.y
      }
      request.post({ url: baseURL + '/api/v1/player/registerAdditionalScreenOnPlayer/' + playerConfig.id, json: registerScreenData }, function (err, httpResponse, body) {
        if (err) {
          console.log(err)
          return
        }
        closeAllOpenBrowserWindows();
      });
    }
  }
}

function displayErrorScreen(errorbody, err, electronScreen) {
  // This function is the err rscreen dipslayer. It gracefully displays error screens 
  // if there is a problem with the display. In teh future it will also report errors
  // to the management server.
  // If electronScreen is defined it will only open an error screen on that screen
  // If not it will open on all screens.


  // This gets the IP addresses of the network cards on the system to display on teh screen
  try {
    var interfaces = os.networkInterfaces();
    var addresses = [];
    for (var k in interfaces) {
      for (var k2 in interfaces[k]) {
        var address = interfaces[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
          addresses.push(address.address);
        }
      }
    }
    if (electronScreen) {
      var browser = new BrowserWindow({
        fullscreen: true,
        alwaysOnTop: shouldAlwaysBeOnTop,
        frame: false,
        x: electronScreen.bounds.x + 50,
        y: electronScreen.bounds.y + 50,
        webPreferences: {
          webviewTag: true,
          additionalArguments: [
            "--remote-debugging-port=8315"
          ]
        }
      });
      const tmpobj = tmp.fileSync({ postfix: '.html' });
      var renderedHTML = pug.renderFile(layoutDirectory + 'error.pug', { errorbody: errorbody, err: err, ips: addresses });
      fs.writeFileSync(tmpobj.name, renderedHTML)
      browser.loadURL('file://' + tmpobj.name);
    } else {
      is_error = true;
      closeAllOpenBrowserWindows()
      var currentScreens = electron.screen.getAllDisplays()
      for (screen of currentScreens) {
        var browser = new BrowserWindow({
          fullscreen: true,
          frame: false,
          x: screen.bounds.x + 50,
          y: screen.bounds.y + 50,
          alwaysOnTop: shouldAlwaysBeOnTop,
          webPreferences: {
            webviewTag: true,
            additionalArguments: [
              "--remote-debugging-port=8315"
            ]
          }
        });
        const tmpobj = tmp.fileSync({ postfix: '.html' });
        var renderedHTML = pug.renderFile(layoutDirectory + 'error.pug', { errorbody: errorbody, err: err, ips: addresses });
        fs.writeFileSync(tmpobj.name, renderedHTML)
        browser.loadURL('file://' + tmpobj.name);
      }

    }
  } catch (error) {
    process.exit(1)
  }
}

function displayAdoptionScreen(playerConfig) {
  var currentScreens = electron.screen.getAllDisplays()
  for (screen of currentScreens) {
    var browser = new BrowserWindow({
      fullscreen: true,
      frame: false,
      x: screen.bounds.x + 50,
      y: screen.bounds.y + 50,
      alwaysOnTop: shouldAlwaysBeOnTop,
      webPreferences: {
        webviewTag: true,
        additionalArguments: [
          "--remote-debugging-port=8315"
        ]
      }
    });
    const tmpobj = tmp.fileSync({ postfix: '.html' });
    var renderedHTML = pug.renderFile(layoutDirectory + 'layout1.pug', { main: [{ url: `https://app.displane.cloud/.well-known/adopt?id=${playerConfig.adoptionId}` }] });
    fs.writeFileSync(tmpobj.name, renderedHTML)
    browser.loadURL('file://' + tmpobj.name);
  }

}

function processConfig(onlyCheckForNewConfig) {
  // This process checks that the device is ready to be used.
  // This also fires the "updateInventory" command and sets up 
  // the 8 minute timer for inventory updating.

  request({
    url: baseURL + '/api/v1/player/config/' + config.playerId,
    headers: {
      'X-Displane-Shared-Secret': config.sharedSecret
    }
  }, function (err, httpResponse, body) {
    if (err) {
      console.log("Unable to contact management server... Trying again")
      clearInterval(currentInterval)
      currentInterval = setInterval(getConfig, 10000);
      if (!activeConfigId) {
        displayErrorScreen("Error communicating with the management server - do you have an internet connection?", err);
        errorOccouredDuringStartup = true
      }
    } else {
      var parsedResponse

      try {
        parsedResponse = JSON.parse(body)
      } catch (e) {
        console.log("Unable to contact management server... Trying again here")

        clearInterval(currentInterval)
        currentInterval = setInterval(getConfig, 10000);
        return;
      }

      var currentBrowserWindows = BrowserWindow.getAllWindows()

      if (currentBrowserWindows.length > parsedResponse.screens.length) {
        console.log("Closing all open browser windows due to currentBrowserWindows.length being larger than the stored screen length in Displane")
        closeAllOpenBrowserWindows()
      }

      if (parsedResponse.exit == "true") {
        // If server tells the player to exit, do so
        process.exit(0)
      }

      if (errorOccouredDuringStartup) {
        errorOccouredDuringStartup = false
        is_error = false
      }

      if (onlyCheckForNewConfig) {
        if (parsedResponse.latestConfig != activeConfigId) {
          console.log("Detected config change")
          is_error = false
          closeAllOpenBrowserWindows()
          activeConfigId = parsedResponse.latestConfig
        }
      } else {
        if (parsedResponse.isAdopted == 0) {
          displayAdoptionScreen(parsedResponse)
        } else {
          configureCrons(parsedResponse.crons)
          initializeScreens(parsedResponse)
        }
        if (!activeConfigId) {
          activeConfigId = parsedResponse.latestConfig
          clearInterval(currentInterval)
          currentInterval = setInterval(function () { processConfig(true); }, 10000);
        }
      }

      updateRemoteSystemInformation(config.playerId)
    }

  })
}

async function getConfig() {

  // Checks for player id in environment file. if no 
  //player id exisits it assumes the player has not registed
  // with the server before and automatically registers
  if (!config.playerId) {
    console.log("No player ID saved in env file, registering with server");


    var info = await getSystemInfo()

    var registerData = {
      screens: [],
      info: info
    }

    for (const screen of electron.screen.getAllDisplays()) {
      registerData.screens.push({
        id: screen.id,
        x: screen.size.width,
        y: screen.size.height,
        xpos: screen.bounds.x,
        ypos: screen.bounds.y
      })
    }

    // POST Data to server to rgister player in database.

    request.post({ url: baseURL + '/api/v1/player/register', json: registerData }, function (err, httpResponse, body) {
      if (err) {
        console.log(err)
        // If the managemetn server cannot be contacted, display an error screen explaining whats up
        console.log("Error when registering player, please check your internet connection and try again.");
        clearInterval(currentInterval)
        // Sets up an interval to call the complete getConfig function when initialy registering and not just with the onlyCheckForNewConfig flag
        currentInterval = setInterval(getConfig, 10000);
        if (!activeConfigId && !errorOccouredDuringStartup) {
          displayErrorScreen("Error when registering player - do you have an internet connection?", err);
          errorOccouredDuringStartup = true
        }
        return
      }


      var config = {
        playerId: body.playerId,
        sharedSecret: body.sharedSecret
      }
      fs.writeFileSync(configFileName, JSON.stringify(config));
      reloadConfig()
      processConfig()

    });

  } else {
    // If all required things are in the .env file it will use these to get and process the configuration from the server
    processConfig();
  }

}


// Get config once electron application is ready to be launched
app.on('ready', getConfig)

// Reopen windows when all windows are closed. Sort of "watchdog"
app.on('window-all-closed', function () {
  console.log("Event fired: window-all-closed")
  if (is_error == false) {
    console.log("Processing config due to window-all-closed")
    processConfig();
  }
})

process.on('uncaughtException', function (err) {
  console.log(err);
  app.relaunch();
  app.exit();
});

function closeAllOpenBrowserWindows(req, res) {
  console.log("Closing all open browser windows")
  schedule.gracefulShutdown();
  var currentBrowserWindows = BrowserWindow.getAllWindows()
  for (window of currentBrowserWindows) {
    window.destroy()
  }
}

async function configureCrons(crons) {
  for (cron of configuredCronJobs) {
    cron.cancel()
  }

  for (cron of crons) {
    console.log("Setting up cron %s", cron.name)
    try {
      if (cron.schedule == "startup") {
        exec(cron.command)
      } else {
        const job = schedule.scheduleJob(cron.schedule, function () {
          exec(cron.command)
        });
        configuredCronJobs.push(job)
      }
    } catch (e) {
      console.error(e)
    }

  }
}

async function getSystemInfo() {
  try {
    var bootTime = Date.now() - (require('os').uptime() + "00")
    var systemInfo = await si.system()

    var systemModel = systemInfo.model
    var systemManufacturer = systemInfo.manufacturer

    var networkInterfaces = await si.networkInterfaces()

    var ips = []

    for (int of networkInterfaces) {
      if (int.ip4) {
        ips.push(int.ip4)
      }

    }
    return {
      hostname: os.hostname(),
      type: os.platform() + " " + os.release(),
      ip: ips.join(),
      model: systemManufacturer + " " + systemModel,
      bootTime: bootTime
    }
  } catch (e) {
    console.error(e)
    return false
  }

}

async function updateRemoteSystemInformation(playerId) {
  var info = await getSystemInfo()
  try {
    await request.post({
      url: baseURL + '/api/v1/player/config/' + playerId,
      headers: {
        'X-Displane-Shared-Secret': config.sharedSecret
      },
      json: info
    })
  } catch (error) {
    console.error("Error updating remote system information")
  }
}

async function checkHealth(req, res) {
  var currentBrowserWindows = BrowserWindow.getAllWindows()
  var errorOccoured = false
  for (window of currentBrowserWindows) {
    try {
      await window.webContents.executeJavaScript('console.log("Displane healthcheck");')
    } catch (error) {
      console.log(error)
      errorOccoured = true
    }
  }

  if (errorOccoured) {
    res.sendStatus(500)
  } else {
    res.sendStatus(200)
  }

}

webApp.get('/health', checkHealth)

webApp.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})